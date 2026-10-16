import { store } from "./_admin.mjs";
import { processBoldWebhook, recordInboxFailure, logBoldEvent } from "./_bold-webhook.mjs";

const STALE_PROCESSING_MS = 10 * 60 * 1000;
const MAX_PER_RUN = 20;

export default async () => {
  const { blobs = [] } = await store.list({ prefix: "webhook-inbox/" });
  const now = Date.now();
  let processed = 0;

  for (const blob of blobs) {
    if (processed >= MAX_PER_RUN) break;

    const current = await store.getWithMetadata(blob.key, { type: "json", consistency: "strong" });
    const item = current?.data;
    if (!item || item.processedAt || !item.event) continue;

    const status = String(item.status || "pending");
    const due = status === "pending" || (Boolean(item.nextAttemptAt) && Date.parse(item.nextAttemptAt) <= now);
    const processingAt = Date.parse(String(item.processingAt || ""));
    const staleProcessing =
      status === "processing" &&
      Number.isFinite(processingAt) &&
      now - processingAt >= STALE_PROCESSING_MS;

    if (status === "processing" ? !staleProcessing : !["pending", "error"].includes(status) || !due) continue;

    try {
      await processBoldWebhook(item.event);
    } catch (error) {
      const failed = await recordInboxFailure(blob.key, error);
      logBoldEvent("error", "bold_webhook_retry_failed", {
        key: blob.key,
        code: String(error?.code || ""),
        error: String(error?.message || error).slice(0, 300),
        attempts: failed?.attempts ?? null,
        terminal: failed?.terminal ?? null
      });
    }
    processed++;
  }
};

export const config = {
  schedule: "*/5 * * * *"
};
