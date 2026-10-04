import { store, json, requireAdmin } from "./_admin.mjs";
import { processBoldWebhook, webhookInboxKey } from "./_bold-webhook.mjs";

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    const { blobs } = await store.list({ prefix: "webhook-inbox/" });
    const events = [];
    for (const b of blobs) {
      const item = await store.get(b.key, { type: "json", consistency: "strong" });
      if (item) {
        events.push({
          key: b.key,
          id: item.id,
          type: item.type,
          status: item.status,
          reference: item.reference || "",
          receivedAt: item.receivedAt,
          processedAt: item.processedAt || "",
          lastError: item.lastError || ""
        });
      }
    }
    events.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    return json({ events });
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body = {};
  try { body = await req.json(); } catch {}
  const id = String(body?.eventId || "").trim();
  if (!id) return json({ error: "Falta eventId" }, 400);

  const item = await store.get(webhookInboxKey(id), { type: "json", consistency: "strong" });
  if (!item?.event) return json({ error: "Evento no encontrado" }, 404);

  const result = await processBoldWebhook(item.event);
  return json({ ok: true, result });
};
