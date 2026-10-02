import { store, json } from "./_admin.mjs";

const REF = /^[A-Za-z0-9_-]{1,80}$/;

export default async (req) => {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  const ref = String(new URL(req.url).searchParams.get("ref") || "").trim();
  if (!REF.test(ref)) return json({ error: "Referencia inválida" }, 400);
  const order = await store.get("orders/" + ref, { type: "json", consistency: "strong" });
  if (!order) return json({ error: "Pedido no encontrado" }, 404);

  return json({
    reference: order.reference,
    paymentStatus: order.paymentStatus || "pendiente",
    status: order.status || "nuevo",
    total: Number(order.total) || 0,
    paymentLink: order.paymentLink || "",
    boldPaymentLink: order.boldPaymentLink || ""
  });
};
