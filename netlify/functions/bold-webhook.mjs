import crypto from "node:crypto";
import { store } from "./_admin.mjs";
import { processBoldWebhook, safeEventId, webhookInboxKey } from "./_bold-webhook.mjs";

function encodeForm(data) {
  return Object.keys(data)
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? ""))
    .join("&");
}

function validSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const encoded = Buffer.from(rawBody, "utf8").toString("base64");
  const hashed = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
  const a = Buffer.from(hashed);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async (req, context) => {
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

  const eventId = safeEventId(event?.id);
  const allowedTypes = new Set(["SALE_APPROVED", "SALE_REJECTED", "VOID_APPROVED", "VOID_REJECTED"]);
  if (!eventId || !allowedTypes.has(String(event?.type || ""))) {
    return new Response("Evento Bold inválido", { status: 400 });
  }

  const inboxKey = webhookInboxKey(eventId);
  const now = new Date().toISOString();
  const existing = await store.get(inboxKey, { type: "json", consistency: "strong" });

  // Persist the signed/validated event before returning 200. The actual order
  // update and Meta outbox work happens after the response via waitUntil.
  if (!existing?.processedAt) {
    await store.setJSON(inboxKey, {
      id: eventId,
      type: String(event.type),
      receivedAt: existing?.receivedAt || now,
      updatedAt: now,
      status: "pending",
      processedAt: "",
      reference: existing?.reference || "",
      event
    });
  }

  const work = processBoldWebhook(event).catch(async (error) => {
    console.error("No se pudo procesar webhook Bold:", error);
    const current = await store.get(inboxKey, { type: "json", consistency: "strong" });
    if (current && !current.processedAt) {
      current.status = "error";
      current.lastError = String(error?.message || error).slice(0, 1000);
      current.updatedAt = new Date().toISOString();
      await store.setJSON(inboxKey, current);
    }
  });

  if (typeof context?.waitUntil === "function") {
    context.waitUntil(work);
  } else {
    await work;
  }

  return new Response("OK", { status: 200 });
};
