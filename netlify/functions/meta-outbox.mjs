import { store, json, requireAdmin } from "./_admin.mjs";
import { processOutboxKey } from "./_meta-outbox.mjs";

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    const { blobs } = await store.list({ prefix: "meta-outbox/" });
    const items = [];
    for (const b of blobs) {
      const item = await store.get(b.key, { type: "json", consistency: "strong" });
      if (item) {
        items.push({
          key: b.key,
          eventId: item.eventId,
          kind: item.kind,
          orderReference: item.orderReference,
          status: item.status,
          attempts: item.attempts,
          nextAttemptAt: item.nextAttemptAt || "",
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          sentAt: item.sentAt || "",
          lastError: item.lastError || ""
        });
      }
    }
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return json({ items });
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body = {};
  try { body = await req.json(); } catch {}
  const key = String(body?.key || "").trim();
  if (!key.startsWith("meta-outbox/")) return json({ error: "Clave inválida" }, 400);

  const result = await processOutboxKey(key);
  return json({ ok: true, result });
};
