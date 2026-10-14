import { store, listJson, json, requireAdmin, safeId } from "./_admin.mjs";
import { validateShippingInput, SHIPPING_STATUSES } from "./_admin-data.mjs";

// Despachos. Prefijo independiente "shipping/<referencia>". Esta función NUNCA escribe en
// "orders/": cambiar un despacho no puede alterar el estado de pago ni el pedido. Solo
// guarda lo que el administrador escribe (no se inventan guías ni entregas).

const MAX_HISTORY = 40;

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    const rows = await listJson("shipping/");
    rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return json({ shipping: rows, options: { statuses: SHIPPING_STATUSES } });
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const checked = validateShippingInput(body);
  if (checked.errors) return json({ error: checked.errors[0], errors: checked.errors }, 400);
  const input = checked.value;
  const reference = safeId(input.reference);

  const order = await store.get("orders/" + reference, { type: "json", consistency: "strong" });
  if (!order) return json({ error: "Pedido no encontrado" }, 404);
  if (order.status === "cancelado" && input.status !== "pendiente") {
    return json({ error: "El pedido está cancelado: no se puede despachar." }, 409);
  }

  const key = "shipping/" + reference;
  const now = new Date().toISOString();
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  const before = current?.data || null;
  const entry = { at: now, status: input.status, carrier: input.carrier, guide: input.guide };
  const next = {
    ...(before || {}),
    ...input,
    createdAt: before?.createdAt || now,
    updatedAt: now,
    history: [...(before?.history || []), entry].slice(-MAX_HISTORY)
  };

  const result = before
    ? await store.setJSON(key, next, { onlyIfMatch: current.etag })
    : await store.setJSON(key, next, { onlyIfNew: true });
  if (result?.modified === false) return json({ error: "El despacho cambió mientras lo editabas. Recarga e inténtalo de nuevo." }, 409);
  return json({ ok: true, shipping: next });
};
