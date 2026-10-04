import crypto from "node:crypto";
import { store, getJson, listJson, json, requireAdmin, safeId } from "./_admin.mjs";
import { validateCart } from "./_catalog.mjs";
import { mergeClientOrder } from "./_orders.mjs";

const IDEM = /^[A-Za-z0-9_-]{16,120}$/;
const PAYMENT_METHODS = new Set(["Link de pago (Bold)", "Transferencia bancaria"]);

function money(total) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(total);
}

function orderText(cart) {
  const lines = cart.items.map(i =>
    "- " + i.name +
    (i.color ? ", color " + i.color : "") +
    ", talla " + i.size +
    " (x" + i.qty + ") " + money(i.unitPrice * i.qty)
  );
  lines.push("Subtotal productos: " + money(cart.subtotal));
  lines.push("Envío nacional (" + cart.packageCount + (cart.packageCount === 1 ? " paquete" : " paquetes") + "): " + money(cart.shippingFee));
  lines.push("Total del pedido: " + money(cart.total));
  lines.push("Entrega estimada: 3–5 días hábiles desde el despacho.");
  return lines.join("\n");
}

function fingerprint(body, cart) {
  return crypto.createHash("sha256").update(JSON.stringify({
    items: cart.items,
    paymentMethod: String(body?.paymentMethod || ""),
    name: String(body?.name || "").trim(),
    address: String(body?.address || "").trim(),
    city: String(body?.city || "").trim(),
    phone: String(body?.phone || "").trim()
  })).digest("hex");
}

function newReference() {
  return "MF" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(5).toString("hex").toUpperCase();
}

async function getStrongJson(key) { return await store.get(key, { type: "json", consistency: "strong" }); }

async function conditionalCreate(key, value) {
  const result = await store.setJSON(key, value, { onlyIfNew: true });
  // @netlify/blobs 10.7.12 has a known conditional-write issue where some
  // non-412 failures can report modified=true with an empty etag.
  if (result?.modified && !result?.etag) throw new Error("No se pudo confirmar la escritura condicional");
  return result;
}

async function createOrReuseOrder(body) {
  const idempotencyKey = String(body?.idempotencyKey || "").trim();
  if (!IDEM.test(idempotencyKey)) throw new Error("Falta una clave de idempotencia válida");

  const cart = validateCart(body?.items);
  const paymentMethod = String(body?.paymentMethod || "").trim();
  if (!PAYMENT_METHODS.has(paymentMethod)) throw new Error("Medio de pago no válido");

  const fp = fingerprint(body, cart);
  const idemKey = "checkout-idempotency/" + idempotencyKey;
  const existingIdem = await getStrongJson(idemKey);
  if (existingIdem) {
    if (existingIdem.fingerprint !== fp) {
      const err = new Error("La clave de idempotencia ya fue usada para otro pedido");
      err.status = 409;
      throw err;
    }
    const existingOrder = await getStrongJson("orders/" + existingIdem.reference);
    if (existingOrder) return existingOrder;
  }

  const reference = existingIdem?.reference || newReference();
  const now = new Date().toISOString();
  const orderInput = {
    reference,
    name: body?.name,
    address: body?.address,
    city: body?.city,
    phone: body?.phone,
    pedido: orderText(cart),
    totalFormatted: money(cart.total),
    paymentMethod,
    paymentLink: "",
    boldPaymentLink: "",
    notes: body?.notes,
    fbp: body?.fbp,
    fbc: body?.fbc,
    clientUserAgent: body?.clientUserAgent,
    eventSourceUrl: body?.eventSourceUrl,
    items: cart.items
  };

  if (!existingIdem) {
    const created = await conditionalCreate(idemKey, {
      reference,
      fingerprint: fp,
      createdAt: now
    });
    if (!created.modified) {
      const winner = await getStrongJson(idemKey);
      if (!winner || winner.fingerprint !== fp) {
        const err = new Error("No se pudo reservar el pedido de forma idempotente");
        err.status = 409;
        throw err;
      }
      const winnerOrder = await getStrongJson("orders/" + winner.reference);
      if (winnerOrder) return winnerOrder;
      orderInput.reference = winner.reference;
    }
  }

  const existing = await getStrongJson("orders/" + orderInput.reference);
  const order = mergeClientOrder(existing, orderInput, now, cart.total);
  if (!existing) {
    const created = await conditionalCreate("orders/" + order.reference, order);
    if (!created.modified) {
      const winner = await getStrongJson("orders/" + order.reference);
      if (winner) return winner;
      throw new Error("No se pudo confirmar la creación del pedido");
    }
  } else {
    // Customer details can be retried, but the server-owned amount/items remain.
    await store.setJSON("orders/" + order.reference, {
      ...existing,
      name: order.name || existing.name || "",
      address: order.address || existing.address || "",
      city: order.city || existing.city || "",
      phone: order.phone || existing.phone || "",
      paymentMethod: order.paymentMethod || existing.paymentMethod || "",
      fbp: order.fbp || existing.fbp || "",
      fbc: order.fbc || existing.fbc || "",
      clientUserAgent: order.clientUserAgent || existing.clientUserAgent || "",
      eventSourceUrl: order.eventSourceUrl || existing.eventSourceUrl || "",
      updatedAt: now
    });
  }
  return await getStrongJson("orders/" + order.reference);
}

export default async (req) => {
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const order = await createOrReuseOrder(body);
      return json({
        ok: true,
        reference: order.reference,
        total: order.total,
        totalFormatted: order.totalFormatted,
        paymentStatus: order.paymentStatus,
        status: order.status,
        paymentMethod: order.paymentMethod
      });
    } catch (e) {
      return json({ error: e.message || "No se pudo guardar el pedido" }, e.status || 400);
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

export { createOrReuseOrder };
