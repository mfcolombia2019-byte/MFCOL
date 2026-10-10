import { store } from "./_admin.mjs";
import { processBoldWebhook } from "./_bold-webhook.mjs";

const STALE_PROCESSING_MS = 10 * 60 * 1000;
const MAX_PER_RUN = 20;

function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, attempts - 1)));
}

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
      const latest = await store.getWithMetadata(blob.key, { type: "json", consistency: "strong" });
      if (latest?.data && !latest.data.processedAt) {
        const attempts = Number(latest.data.attempts || 0) + 1;
        const retryable = attempts < 8;
        const failed = {
          ...latest.data,
          status: "error",
          attempts,
          processingAt: "",
          updatedAt: new Date().toISOString(),
          lastError: String(error?.message || error).slice(0, 1000),
          nextAttemptAt: retryable
            ? new Date(Date.now() + retryDelayMs(attempts)).toISOString()
            : ""
        };
        const written = await store.setJSON(blob.key, failed, { onlyIfMatch: latest.etag });
        if (written?.modified && !written?.etag) {
          throw new Error("No se pudo confirmar el estado de reintento del inbox Bold");
        }
      }
      console.error("Reintento de webhook Bold falló:", blob.key, error);
    }
    processed++;
  }
};

export const config = {
  schedule: "*/5 * * * *"
};
