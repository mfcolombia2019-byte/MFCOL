import { store, getJson, listJson, json, requireAdmin, safeId } from "./_admin.mjs";

function cleanOrder(input) {
  const reference = safeId(input?.reference);
  if (!reference) throw new Error("Referencia inválida");
  const total = Math.round(Number(input?.totalNumber ?? input?.total));
  if (!Number.isFinite(total) || total < 1000 || total > 20000000) throw new Error("Total inválido");

  return {
    reference,
    createdAt: String(input?.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
    name: String(input?.name || "").trim().slice(0, 120),
    address: String(input?.address || "").trim().slice(0, 240),
    city: String(input?.city || "").trim().slice(0, 100),
    phone: String(input?.phone || "").trim().slice(0, 40),
    pedido: String(input?.pedido || "").trim().slice(0, 5000),
    total,
    totalFormatted: String(input?.totalFormatted || ""),
    paymentMethod: String(input?.paymentMethod || "por definir").slice(0, 80),
    paymentLink: String(input?.paymentLink || "").slice(0, 500),
    boldPaymentLink: String(input?.boldPaymentLink || "").slice(0, 120),
    status: String(input?.status || "nuevo").slice(0, 40),
    paymentStatus: String(input?.paymentStatus || "pendiente").slice(0, 40),
    notes: String(input?.notes || "").slice(0, 2000)
  };
}

export default async (req) => {
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const order = cleanOrder(body);
      const existing = await getJson("orders/" + order.reference);
      if (existing) {
        order.createdAt = existing.createdAt || order.createdAt;
        order.status = existing.status || order.status;
        order.paymentStatus = existing.paymentStatus || order.paymentStatus;
        order.notes = existing.notes || order.notes;
        order.boldPaymentLink = order.boldPaymentLink || existing.boldPaymentLink || "";
      }
      await store.setJSON("orders/" + order.reference, order);
      return json({ ok: true, reference: order.reference });
    } catch (e) {
      return json({ error: e.message || "No se pudo guardar el pedido" }, 400);
    }
  }

  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    const orders = await listJson("orders/");
    orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json({ orders });
  }

  if (req.method === "PATCH") {
    try {
      const body = await req.json();
      const reference = safeId(body?.reference);
      if (!reference) return json({ error: "Referencia inválida" }, 400);
      const current = await getJson("orders/" + reference);
      if (!current) return json({ error: "Pedido no encontrado" }, 404);

      const allowedStatus = ["nuevo","confirmado","preparando","enviado","entregado","cancelado"];
      const allowedPayment = ["pendiente","aprobado","rechazado","anulado"];
      if (body.status && allowedStatus.includes(body.status)) current.status = body.status;
      if (body.paymentStatus && allowedPayment.includes(body.paymentStatus)) current.paymentStatus = body.paymentStatus;
      if (body.notes != null) current.notes = String(body.notes).slice(0, 2000);
      current.updatedAt = new Date().toISOString();

      await store.setJSON("orders/" + reference, current);
      return json({ ok: true, order: current });
    } catch (e) {
      return json({ error: e.message || "No se pudo actualizar" }, 400);
    }
  }

  return json({ error: "Método no permitido" }, 405);
};
