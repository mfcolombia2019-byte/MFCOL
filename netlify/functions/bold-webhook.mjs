import crypto from "node:crypto";
import { store } from "./_admin.mjs";
import { processBoldWebhook, safeEventId, webhookInboxKey, ensureInbox } from "./_bold-webhook.mjs";
import { processOutboxKey } from "./_meta-outbox.mjs";
import { sendWhatsAppOrderNotification } from "./_whatsapp.mjs";

function encodeForm(data) {
  return Object.keys(data).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? "")).join("&");
}

export function getBoldWebhookSecret(env = process.env) {
  const context = String(env?.CONTEXT || "").trim().toLowerCase();
  if (context === "production") {
    return String(env?.BOLD_SECRET_KEY || "");
  }
  // Bold documents an empty signing key for its test webhook. Non-production
  // deploys use the isolated mfc-admin-nonprod store, so a public test endpoint
  // cannot mutate production orders, inboxes, or Meta outbox records.
  return "";
}

export function validSignature(rawBody, signature, secret) {
  if (signature == null || signature === "") return false;
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
  const contextName = String(process.env.CONTEXT || "").trim().toLowerCase();
  const secret = getBoldWebhookSecret();

  if (contextName === "production" && !secret) {
    console.error("BOLD_SECRET_KEY no está configurada en producción");
    return new Response("Configuración de webhook incompleta", { status: 500 });
  }
  if (!validSignature(rawBody, signature, secret)) return new Response("Firma inválida", { status: 400 });

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return new Response("JSON inválido", { status: 400 }); }

  const eventId = safeEventId(event?.id);
  const allowedTypes = new Set(["SALE_APPROVED", "SALE_REJECTED", "VOID_APPROVED", "VOID_REJECTED"]);
  if (!eventId || !allowedTypes.has(String(event?.type || ""))) {
    return new Response("Evento Bold inválido", { status: 400 });
  }

  const inboxKey = webhookInboxKey(eventId);
  try {
    await ensureInbox(event);
  } catch (error) {
    console.error("No se pudo persistir el inbox de Bold:", error);
    return new Response("Error interno", { status: 500 });
  }

  const work = processBoldWebhook(event)
    .then(async (result) => {
      if (result?.duplicate || result?.busy) return;

      if (result?.outboxKey) {
        try {
          await processOutboxKey(result.outboxKey);
        } catch (error) {
          console.error("No se pudo enviar Purchase a Meta:", error);
        }
      }

      if (event.type === "SALE_APPROVED" && result?.reference) {
        try {
          const approvedOrder = await store.get("orders/" + String(result.reference), {
            type: "json",
            consistency: "strong"
          });
          if (approvedOrder?.paymentStatus === "aprobado") {
            const notification = await sendWhatsAppOrderNotification(approvedOrder);
            if (notification?.skipped) {
              console.log("WhatsApp pedido omitido:", notification.reason);
            } else {
              console.log("WhatsApp pedido enviado:", result.reference);
            }
          }
        } catch (error) {
          console.error("No se pudo enviar notificación de pedido por WhatsApp:", error);
        }
      }

      try {
        const d = event.data || {};
        const reference = String(result?.reference || "").trim();
        const paymentId = String(d.payment_id || event.subject || "").trim();
        const paymentStatus =
          event.type === "SALE_APPROVED" ? "aprobado" :
          event.type === "SALE_REJECTED" ? "rechazado" :
          event.type === "VOID_APPROVED" ? "anulado" :
          event.type === "VOID_REJECTED" ? "rechazado" : "pendiente";
        await fetch(new URL(req.url).origin + "/", {
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
      } catch (error) {
        console.error("No se pudo registrar el formulario de pago:", error);
      }
    })
    .catch(async (error) => {
      console.error("No se pudo procesar webhook Bold:", error);
      const current = await store.get(inboxKey, { type: "json", consistency: "strong" });
      if (current && !current.processedAt) {
        current.status = "error";
        current.lastError = String(error?.message || error).slice(0, 1000);
        current.updatedAt = new Date().toISOString();
        await store.setJSON(inboxKey, current);
      }
    });

  if (typeof context?.waitUntil === "function") context.waitUntil(work);
  else await work;

  return new Response("OK", { status: 200 });
};
