import { buildMetaPurchase, sendMetaEvent } from "./_meta.mjs";
import { outboxKeyForPurchase } from "./_orders.mjs";

import { store as outbox } from "./_admin.mjs";

function nowIso() { return new Date().toISOString(); }

function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, Math.max(30 * 1000, 2 ** Math.max(0, attempts - 1) * 30 * 1000));
}

function conditionalOk(result) {
  if (!result?.modified) return false;
  if (!result?.etag) throw new Error("La escritura condicional del outbox no pudo confirmarse");
  return true;
}

// Nunca almacenar ni registrar el token de acceso, aunque Meta lo reflejara.
function redact(text) {
  let out = String(text ?? "");
  const token = String(process.env.META_CAPI_ACCESS_TOKEN || "");
  if (token.length >= 8) out = out.split(token).join("[redacted]");
  return out;
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Resumen seguro del error de Graph API: solo campos de diagnóstico, sin
// payload del evento ni datos del cliente.
function sanitizeMetaError(error) {
  const body = error?.metaResponse;
  const e = body && typeof body === "object" ? body.error : null;
  const traceId = String((e && e.fbtrace_id) || (body && body.fbtrace_id) || "").slice(0, 80);
  if (!e || typeof e !== "object") return traceId ? { type: "", code: null, subcode: null, message: "", fbtraceId: traceId } : null;
  return {
    type: redact(e.type).slice(0, 80),
    code: finiteOrNull(e.code),
    subcode: finiteOrNull(e.error_subcode),
    message: redact(e.message).slice(0, 240),
    fbtraceId: traceId
  };
}

export async function enqueuePurchase(order) {
  const event = buildMetaPurchase(order);
  const eventId = event.event_id;
  const key = outboxKeyForPurchase(order.reference, order.paymentId, order.webhookEventId);

  const existing = await outbox.get(key, { type: "json", consistency: "strong" });
  if (existing?.status === "sent") return { key, created: false, status: "sent", eventId };
  if (existing) return { key, created: false, status: existing.status, eventId };

  const record = {
    key,
    kind: "Purchase",
    eventId,
    orderReference: String(order.reference || ""),
    paymentId: String(order.paymentId || ""),
    webhookEventId: String(order.webhookEventId || ""),
    status: "pending",
    attempts: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    nextAttemptAt: nowIso(),
    lastError: "",
    event
  };

  const result = await outbox.setJSON(key, record, { onlyIfNew: true });
  if (result?.modified && !result?.etag) throw new Error("No se pudo confirmar la creación del outbox");
  if (result?.modified) return { key, created: true, status: "pending", eventId };

  const winner = await outbox.get(key, { type: "json", consistency: "strong" });
  return { key, created: false, status: winner?.status || "pending", eventId };
}

export async function processOutboxKey(key) {
  const current = await outbox.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!current?.data) return { ok: false, skipped: true, reason: "not_found" };
  if (current.data.status === "sent") return { ok: true, skipped: true, reason: "sent", key };
  const now = Date.now();
  if (current.data.status === "processing") {
    const processingAt = Date.parse(String(current.data.processingAt || ""));
    const stale = Number.isFinite(processingAt) && now - processingAt >= 10 * 60 * 1000;
    if (!stale) return { ok: false, skipped: true, reason: "busy", key };
  }
  if (current.data.nextAttemptAt && new Date(current.data.nextAttemptAt).getTime() > now) {
    return { ok: false, skipped: true, reason: "not_due", key };
  }

  const attempts = Number(current.data.attempts || 0) + 1;
  const processing = {
    ...current.data,
    status: "processing",
    attempts,
    processingAt: nowIso(),
    updatedAt: nowIso()
  };

  const claimed = await outbox.setJSON(key, processing, { onlyIfMatch: current.etag });
  if (claimed?.modified && !claimed?.etag) throw new Error("No se pudo confirmar el bloqueo del outbox");
  if (!claimed?.modified) return { ok: false, skipped: true, reason: "lost_race", key };

  try {
    const result = await sendMetaEvent(processing.event);
    const meta = result?.response && typeof result.response === "object" ? result.response : {};
    // Un HTTP 200 sin eventos recibidos no es un envío exitoso.
    if (meta.events_received !== undefined && !(Number(meta.events_received) >= 1)) {
      const notReceived = new Error(
        "Meta CAPI respondió sin eventos recibidos (events_received=" + String(meta.events_received).slice(0, 20) + ")"
      );
      notReceived.metaResponse = meta;
      throw notReceived;
    }
    const latest = await outbox.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!latest?.data || latest.data.status !== "processing") {
      return { ok: false, skipped: true, reason: "state_changed", key };
    }
    const sent = {
      ...latest.data,
      status: "sent",
      updatedAt: nowIso(),
      sentAt: nowIso(),
      nextAttemptAt: "",
      lastError: "",
      lastErrorDetail: null,
      lastMetaStatus: null,
      processingAt: "",
      eventsReceived: finiteOrNull(meta.events_received),
      fbtraceId: String(meta.fbtrace_id || "").slice(0, 80),
      testEventCodeActive: Boolean(process.env.META_TEST_EVENT_CODE),
      metaResponse: result.response
    };
    const written = await outbox.setJSON(key, sent, { onlyIfMatch: latest.etag });
    if (written?.modified && !written?.etag) throw new Error("No se pudo confirmar Purchase enviado");
    if (!written?.modified) return { ok: false, skipped: true, reason: "lost_race", key };
    return { ok: true, key, status: "sent", attempts };
  } catch (error) {
    const latest = await outbox.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!latest?.data || latest.data.status !== "processing") {
      throw error;
    }
    const status = Number(error?.metaStatus);
    const retryable = error?.retryable !== false && (status === 429 || status >= 500 || !status);
    const maxAttempts = 8;
    const willRetry = retryable && attempts < maxAttempts;
    const detail = sanitizeMetaError(error);
    const failed = {
      ...latest.data,
      status: "error",
      updatedAt: nowIso(),
      processingAt: "",
      lastError: redact(error?.message || error).slice(0, 1000),
      lastErrorDetail: detail,
      lastMetaStatus: finiteOrNull(error?.metaStatus),
      nextAttemptAt: willRetry
        ? new Date(Date.now() + retryDelayMs(attempts)).toISOString()
        : ""
    };
    // Antes, los fallos terminales no dejaban ningún rastro en los logs.
    console.error("Meta CAPI Purchase falló", {
      key,
      attempts,
      metaStatus: failed.lastMetaStatus,
      code: detail?.code ?? null,
      type: detail?.type || "",
      fbtraceId: detail?.fbtraceId || "",
      willRetry,
      terminal: !willRetry,
      message: failed.lastError.slice(0, 240)
    });
    const written = await outbox.setJSON(key, failed, { onlyIfMatch: latest.etag });
    if (written?.modified && !written?.etag) throw new Error("No se pudo confirmar el error del outbox");
    if (!written?.modified) return { ok: false, skipped: true, reason: "lost_race", key };
    if (willRetry) throw error;
    return { ok: false, key, status: "error", attempts, retryable: false };
  }
}
