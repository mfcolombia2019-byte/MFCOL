import { store, getJson, listJson, json, requireAdmin, safeId } from "./_admin.mjs";
import { mergeClientOrder } from "./_orders.mjs";

export default async (req) => {
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const reference = safeId(body?.reference);
      if (!reference) throw new Error("Referencia inválida");

      const existing = await getJson("orders/" + reference);
      const order = mergeClientOrder(existing, {
        reference,
        name: body?.name,
        address: body?.address,
        city: body?.city,
        phone: body?.phone,
        pedido: body?.pedido,
        totalNumber: body?.totalNumber,
        totalFormatted: body?.totalFormatted,
        paymentMethod: body?.paymentMethod,
        paymentLink: body?.paymentLink,
        boldPaymentLink: body?.boldPaymentLink,
        notes: body?.notes,
        fbp: body?.fbp,
        fbc: body?.fbc,
        clientUserAgent: body?.clientUserAgent,
        eventSourceUrl: body?.eventSourceUrl
      });

      // The browser is never allowed to choose paymentStatus/status.
      // Existing server-confirmed states are preserved; approval comes only
      // from the validated Bold webhook.
      await store.setJSON("orders/" + reference, order);
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
      if (body.status && allowedStatus.includes(body.status)) current.status = body.status;

      // Payment state is deliberately not writable through this API.
      // Bold's validated webhook is the sole source of payment confirmation.
      if (body.paymentStatus != null) {
        return json({ error: "paymentStatus solo puede actualizarlo el webhook validado de Bold" }, 403);
      }

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
