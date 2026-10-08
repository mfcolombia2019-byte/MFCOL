import { store } from "./_admin.mjs";
import { processWhatsAppOutboxKey } from "./_whatsapp.mjs";

export default async () => {
  const { blobs = [] } = await store.list({ prefix: "whatsapp-outbox/" });
  const now = Date.now();
  let processed = 0;

  for (const blob of blobs) {
    if (processed >= 20) break;

    const item = await store.get(blob.key, { type: "json", consistency: "strong" });
    if (!item || item.status === "sent") continue;

    const due = !item.nextAttemptAt || new Date(item.nextAttemptAt).getTime() <= now;
    if (!due) continue;

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
