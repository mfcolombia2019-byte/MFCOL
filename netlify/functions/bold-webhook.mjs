import crypto from "node:crypto";
import { store, getJson } from "./_admin.mjs";

function encodeForm(data) {
  return Object.keys(data)
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? ""))
    .join("&");
}

function validSignature(rawBody, signature, secret) {
  const encoded = Buffer.from(rawBody, "utf8").toString("base64");
  const hashed = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
  if (!signature) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hashed), Buffer.from(signature));
  } catch {
    return false;
  }
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Método no permitido", { status: 405 });

  const rawBody = await req.text();
  const signature = req.headers.get("x-bold-signature") || "";
  const secret = process.env.BOLD_SECRET_KEY || "";

  if (!validSignature(rawBody, signature, secret)) {
    console.error("Firma de webhook Bold inválida");
    return new Response("Firma inválida", { status: 400 });
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return new Response("JSON inválido", { status: 400 }); }

  const d = event.data || {};
  const reference = String(d.metadata?.reference || "").trim();
  const paymentId = String(d.payment_id || event.subject || "").trim();
  const type = String(event.type || "").trim();
  const paymentStatus =
    type === "SALE_APPROVED" ? "aprobado" :
    type === "SALE_REJECTED" ? "rechazado" :
    type === "VOID_APPROVED" ? "anulado" :
    type === "VOID_REJECTED" ? "rechazado" : "pendiente";

  // Idempotencia: si ya procesamos este evento, no volvemos a crear/alterar datos.
  if (event.id) {
    const eventKey = "webhooks/" + safeEventId(event.id);
    if (await getJson(eventKey)) return new Response("OK", { status: 200 });
    await store.setJSON(eventKey, { receivedAt: new Date().toISOString(), type });
  }

  if (reference) {
    const existing = await getJson("orders/" + reference);
    const order = existing || {
      reference,
      createdAt: new Date().toISOString(),
      name: "",
      address: "",
      city: "",
      phone: "",
      pedido: "",
      total: Number(d.amount?.total || 0),
      totalFormatted: "",
      paymentMethod: String(d.payment_method || ""),
      paymentLink: "",
      boldPaymentLink: reference.startsWith("LNK_") ? reference : "",
      status: "nuevo",
      paymentStatus: "pendiente",
      notes: ""
    };

    order.updatedAt = new Date().toISOString();
    order.paymentStatus = paymentStatus;
    order.paymentId = paymentId;
    order.boldPaymentMethod = String(d.payment_method || "");
    order.boldCode = String(d.bold_code || "");
    order.payerEmail = String(d.payer_email || "").slice(0, 160);
    order.boldCreatedAt = String(d.created_at || "");
    order.webhookType = type;
    await store.setJSON("orders/" + reference, order);
  }

  // Conserva el formulario de Netlify existente para las notificaciones por correo.
  try {
    const siteUrl = new URL(req.url).origin;
    await fetch(siteUrl + "/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encodeForm({
        "form-name": "pagos-confirmados",
        reference,
        payment_id: paymentId,
        valor: d.amount?.total != null ? String(d.amount.total) : "",
        medio_pago: d.payment_method || "",
        estado: paymentStatus
      })
    });
  } catch (e) {
    console.error("No se pudo registrar el formulario de pago:", e);
  }

  return new Response("OK", { status: 200 });
};

function safeEventId(id) {
  const s = String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
  return s || crypto.randomUUID();
}
