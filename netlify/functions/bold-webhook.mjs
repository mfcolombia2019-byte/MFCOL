import crypto from "node:crypto";
import { resolveDeployContext, storeNameForContext, storeMatchesContext } from "./_deploy-context.mjs";
import { store } from "./_admin.mjs";
import * as adminModule from "./_admin.mjs";
import { processBoldWebhook, safeEventId, webhookInboxKey, ensureInbox } from "./_bold-webhook.mjs";
import { processOutboxKey } from "./_meta-outbox.mjs";
import { sendWhatsAppConfirmationForReference } from "./_whatsapp.mjs";

function encodeForm(data) {
  return Object.keys(data).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? "")).join("&");
}

// One JSON line per event so Netlify's function logs can be filtered by `evt`.
// Never pass secrets, signatures, raw bodies or customer data in `fields`.
function logEvent(level, evt, fields = {}) {
  const line = JSON.stringify({ evt, ts: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function errorMessage(error, fallback, max = 300) {
  return String(error?.message || fallback).slice(0, max);
}

/**
 * Signing key for the webhook HMAC.
 *
 * Bold signs with the integration's *secret key* ("llave secreta"). The
 * identity key (BOLD_API_KEY) is only the public `x-api-key`/checkout key: this
 * site even returns it to the browser from crear-link-pago, so it must never
 * be accepted as an HMAC key. Bold documents an empty signing key for its test
 * mode; non-production deploys use that empty key together with the isolated
 * mfc-admin-nonprod store, so a public test endpoint cannot mutate production
 * orders, inboxes, or Meta outbox records.
 */
export function getBoldWebhookSecret(env = process.env, contextName = resolveDeployContext(null, env)) {
  const context = String(contextName || "").trim().toLowerCase();
  if (context === "production") {
    return String(env?.BOLD_SECRET_KEY || "").trim();
  }
  return "";
}

// Bold signs Base64(raw request bytes). `rawBody` may be the exact bytes
// (Buffer/Uint8Array) or a string; the handler passes bytes so that no UTF-8
// decode/encode round trip (for example a stripped BOM) can alter the payload.
export function validSignature(rawBody, signature, secret) {
  if (signature == null || signature === "") return false;
  const bytes = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody || []);
  const encoded = bytes.toString("base64");
  const hashed = crypto.createHmac("sha256", secret).update(encoded).digest("hex");
  const a = Buffer.from(hashed);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async (req, context) => {
  if (req.method !== "POST") return new Response("Método no permitido", { status: 405 });

  const contextName = resolveDeployContext(context);
  // Undefined only when _admin.mjs is replaced by a stub that does not expose it.
  const activeStore = adminModule.APP_STORE_NAME;
  const base = { context: contextName || "unset", store: activeStore || "unknown", requestId: context?.requestId || "" };

  // Fail closed before touching any data if this invocation's deploy context
  // does not match the store _admin.mjs bound at load time (for example CONTEXT
  // missing at runtime while the handler reports "production").
  if (!storeMatchesContext(contextName, activeStore)) {
    logEvent("error", "bold_webhook_store_mismatch", { ...base, expectedStore: storeNameForContext(contextName) });
    return new Response("Configuración de almacén inconsistente", { status: 500 });
  }

  const rawBytes = Buffer.from(await req.arrayBuffer());
  const rawBody = rawBytes.toString("utf8");
  const signature = req.headers.get("x-bold-signature") || "";
  const secret = getBoldWebhookSecret(process.env, contextName);
  const keySource = contextName === "production" ? "BOLD_SECRET_KEY" : "empty-test-key";

  if (contextName === "production" && !secret) {
    logEvent("error", "bold_webhook_secret_missing", { ...base, keySource });
    return new Response("Configuración de webhook incompleta", { status: 500 });
  }
  if (!validSignature(rawBytes, signature, secret)) {
    logEvent("warn", "bold_webhook_invalid_signature", {
      ...base,
      keySource,
      reason: signature ? "mismatch" : "missing_header",
      bodyBytes: rawBytes.length,
      signatureLength: signature.length
    });
    return new Response("Firma inválida", { status: 400 });
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch {
    logEvent("warn", "bold_webhook_invalid_json", { ...base, bodyBytes: rawBytes.length });
    return new Response("JSON inválido", { status: 400 });
  }

  const eventId = safeEventId(event?.id);
  const allowedTypes = new Set(["SALE_APPROVED", "SALE_REJECTED", "VOID_APPROVED", "VOID_REJECTED"]);
  if (!eventId || !allowedTypes.has(String(event?.type || ""))) {
    logEvent("warn", "bold_webhook_invalid_event", { ...base, eventId, type: String(event?.type || "").slice(0, 40) });
    return new Response("Evento Bold inválido", { status: 400 });
  }

  logEvent("info", "bold_webhook_received", { ...base, eventId, type: String(event.type) });

  const inboxKey = webhookInboxKey(eventId);
  try {
    await ensureInbox(event);
  } catch (error) {
    logEvent("error", "bold_webhook_inbox_persist_failed", { ...base, eventId, error: errorMessage(error, "Error de persistencia") });
    return new Response("Error interno", { status: 500 });
  }

  const work = processBoldWebhook(event)
    .then(async (result) => {
      if (result?.duplicate || result?.busy) {
        logEvent("info", "bold_webhook_skipped", { ...base, eventId, duplicate: Boolean(result?.duplicate), busy: Boolean(result?.busy) });
        return;
      }
      logEvent("info", "bold_webhook_processed", { ...base, eventId, type: String(event.type), reference: String(result?.reference || "") });

      if (result?.outboxKey) {
        try {
          await processOutboxKey(result.outboxKey);
        } catch (error) {
          console.error("No se pudo enviar Purchase a Meta:", error);
        }
      }

      if (event.type === "SALE_APPROVED" && result?.reference) {
        try {
          await sendWhatsAppConfirmationForReference(result.reference);
        } catch (error) {
          console.error("No se pudo enviar confirmación por WhatsApp:", error);
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
      const message = String(error?.message || "Error desconocido").slice(0, 500);
      logEvent("error", "bold_webhook_processing_error", { ...base, eventId, error: message });
      try {
        const current = await store.get(inboxKey, { type: "json", consistency: "strong" });
        if (current && !current.processedAt) {
          const attempts = Number(current.attempts || 0) + 1;
          const retryable = attempts < 8;
          current.status = "error";
          current.attempts = attempts;
          current.lastError = message;
          current.updatedAt = new Date().toISOString();
          current.processingAt = "";
          current.nextAttemptAt = retryable
            ? new Date(Date.now() + Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, attempts - 1)))).toISOString()
            : "";
          await store.setJSON(inboxKey, current);
          logEvent("warn", "bold_webhook_error_recorded", { ...base, eventId, attempts, retryable });
        }
      } catch (persistError) {
        logEvent("error", "bold_webhook_error_persist_failed", { ...base, eventId, error: errorMessage(persistError, "Error de persistencia") });
      }
    });

  if (typeof context?.waitUntil === "function") context.waitUntil(work);
  else await work;

  return new Response("OK", { status: 200 });
};
