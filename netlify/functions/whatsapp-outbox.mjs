import { store } from "./_admin.mjs";
import { processWhatsAppOutboxKey } from "./_whatsapp.mjs";

const STALE_PROCESSING_MS = 10 * 60 * 1000;
const MAX_PER_RUN = 20;

export default async () => {
  const { blobs = [] } = await store.list({ prefix: "whatsapp-outbox/" });
  const now = Date.now();
  let processed = 0;

  for (const blob of blobs) {
    if (processed >= MAX_PER_RUN) break;

    const item = await store.get(blob.key, { type: "json", consistency: "strong" });
    if (!item || item.status === "sent") continue;

    const status = String(item.status || "pending");
    const nextAttemptAt = item.nextAttemptAt ? Date.parse(item.nextAttemptAt) : NaN;
    const retryDue = Boolean(item.nextAttemptAt) &&
      Number.isFinite(nextAttemptAt) &&
      nextAttemptAt <= now;
    const pendingDue = status === "pending" && (!item.nextAttemptAt || retryDue);
    const errorDue = status === "error" && retryDue;

    const processingAt = Date.parse(String(item.processingAt || ""));
    const staleProcessing =
      status === "processing" &&
      Number.isFinite(processingAt) &&
      now - processingAt >= STALE_PROCESSING_MS;

    if (!pendingDue && !errorDue && !staleProcessing) continue;

    try {
      await processWhatsAppOutboxKey(blob.key);
    } catch (error) {
      console.error("Reintento WhatsApp falló:", blob.key, error);
    }
    processed++;
  }
};

export const config = {
  schedule: "*/5 * * * *"
};
