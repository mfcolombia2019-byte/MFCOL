import { json, requireAdmin, store, safeId } from "./_admin.mjs";

export function validateAdminBoldOrder(order, reference) {
  if (!reference || !safeId(reference)) return { error: "La referencia del pedido es obligatoria" };
  if (!order || order.reference !== reference) return { error: "Pedido no encontrado" };
  if (order.paymentStatus !== "pendiente") return { error: "Este pedido ya no está pendiente de pago" };
  if (order.paymentMethod !== "Link de pago (Bold)") return { error: "El pedido no está configurado para pagar con Bold" };

  const total = Math.round(Number(order.total));
  if (!Number.isFinite(total) || total < 1000 || total > 20000000) {
    return { error: "El importe del pedido no es válido" };
  }

  return { order, total };
}

export function buildAdminBoldDescription(order) {
  const itemNames = Array.isArray(order?.items) ? order.items.map(i => i?.name).filter(Boolean) : [];
  const description = ("MF Colombia · " + itemNames.slice(0, 3).join(" · ")).slice(0, 100);
  return description.length >= 2 ? description : "Pedido MF Colombia";
}

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  if (!process.env.BOLD_API_KEY) return json({ error: "Falta BOLD_API_KEY en Netlify" }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const reference = safeId(body?.reference);
  if (!reference) return json({ error: "La referencia del pedido es obligatoria" }, 400);

  const order = await store.get("orders/" + reference, { type: "json", consistency: "strong" });
  const validated = validateAdminBoldOrder(order, reference);
  if (validated.error) return json({ error: validated.error }, validated.error === "Pedido no encontrado" ? 404 : 409);

  // The request body is not authoritative for the amount. If a client sends
  // total, it is ignored; the Bold payload always uses order.total.
  const { total } = validated;
  const description = buildAdminBoldDescription(order);

  const payload = {
    amount_type: "CLOSE",
    amount: { currency: "COP", total_amount: total, tip_amount: 0 },
    reference,
    description,
    expiration_date: (Date.now() * 1e6) + (24 * 60 * 60 * 1e9)
  };

  const res = await fetch("https://integrations.api.bold.co/online/link/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "x-api-key " + process.env.BOLD_API_KEY
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payload?.url) return json({ error: "Bold rechazó la creación del link", detail: data.errors || undefined }, 502);

  return json({
    ok: true,
    url: data.payload.url,
    payment_link: data.payload.payment_link,
    reference,
    total
  });
};
