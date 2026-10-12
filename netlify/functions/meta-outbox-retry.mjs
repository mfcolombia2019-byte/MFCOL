import { store } from "./_admin.mjs";
import { processOutboxKey } from "./_meta-outbox.mjs";

const STALE_PROCESSING_MS = 10 * 60 * 1000;
const MAX_PER_RUN = 20;

export default async () => {
  const { blobs = [] } = await store.list({ prefix: "meta-outbox/" });
  const now = Date.now();
  let processed = 0;

  for (const blob of blobs) {
    if (processed >= MAX_PER_RUN) break;

    const item = await store.get(blob.key, { type: "json", consistency: "strong" });
    if (!item || item.status === "sent") continue;

    const status = String(item.status || "pending");
    const due = status === "pending" || (Boolean(item.nextAttemptAt) && Date.parse(item.nextAttemptAt) <= now);
    const processingAt = Date.parse(String(item.processingAt || ""));
    const staleProcessing =
      status === "processing" &&
      Number.isFinite(processingAt) &&
      now - processingAt >= STALE_PROCESSING_MS;

    if (status === "processing" ? !staleProcessing : !["pending", "error"].includes(status) || !due) continue;

    try {
      await processOutboxKey(blob.key);
    } catch (error) {
      console.error("Reintento Meta CAPI falló:", blob.key, error);
    }
    processed++;
  }
};

export const config = {
  schedule: "*/5 * * * *"
};
