import crypto from "node:crypto";
import { store, json, requireAdmin } from "./_admin.mjs";
import { processOutboxKey } from "./_meta-outbox.mjs";

const OUTBOX_PREFIX = "meta-outbox/";
// Prefijo distinto a propósito: "meta-outbox-audit/" NO empieza por
// "meta-outbox/", así que el cron y los listados del outbox no lo ven.
const AUDIT_PREFIX = "meta-outbox-audit/";
const KEY_PATTERN = /^meta-outbox\/[A-Za-z0-9_-]{1,200}$/;
const REF_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

// Meta (Server Event Parameters): event_time puede tener hasta 7 días de
// antigüedad respecto al envío; si cualquier evento es más antiguo, Meta
// rechaza TODA la solicitud. Se deja un margen de 12 h para no tocar el límite
// durante el tránsito. El contenido del evento nunca se modifica para
// "rejuvenecerlo": un evento vencido no es recuperable.
export const META_MAX_EVENT_AGE_SECONDS = 7 * 24 * 60 * 60;
export const RECOVERY_MAX_AGE_SECONDS = META_MAX_EVENT_AGE_SECONDS - 12 * 60 * 60;
const FUTURE_TOLERANCE_SECONDS = 5 * 60;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

function numOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ageDays(seconds) {
  return seconds === null || seconds === undefined ? null : Math.round(seconds / 8640) / 10;
}

function detailOf(item) {
  const d = item?.lastErrorDetail;
  if (!d || typeof d !== "object") return null;
  return {
    type: String(d.type || "").slice(0, 80),
    code: numOrNull(d.code),
    subcode: numOrNull(d.subcode),
    message: String(d.message || "").slice(0, 200),
    fbtraceId: String(d.fbtraceId || "").slice(0, 80)
  };
}

function legacyMetaStatus(record) {
  const direct = numOrNull(record?.lastMetaStatus);
  if (direct !== null) return direct;
  const match = /\((\d{3})\)/.exec(String(record?.lastError || ""));
  return match ? Number(match[1]) : null;
}

// ¿Pudo el intento anterior haber llegado a Meta sin que quedara registro?
// La documentación de Meta describe la deduplicación por event_id + event_name
// dentro de 48 h para parejas Pixel/CAPI; no garantiza que cualquier reenvío
// servidor-servidor sea inocuo. Por eso un resultado incierto exige
// reconocimiento explícito y nunca se reenvía en automático.
export function priorAttemptOutcome(record) {
  if (Number(record?.attempts || 0) === 0) return { outcome: "never_attempted", ambiguous: false };
  if (record?.status === "processing") return { outcome: "interrupted", ambiguous: true };
  const status = legacyMetaStatus(record);
  const text = String(record?.lastError || "");
  if (status !== null && status >= 400 && status < 500) return { outcome: "rejected_by_meta", ambiguous: false };
  if (status === null && /META_CAPI_ACCESS_TOKEN|META_GRAPH_API_VERSION|META_DATASET_ID/.test(text)) {
    return { outcome: "not_sent_config", ambiguous: false };
  }
  if (/sin eventos recibidos/.test(text)) return { outcome: "meta_received_zero", ambiguous: false };
  return { outcome: "unknown", ambiguous: true };
}

// Evaluación pura (sin E/S). Verifica event_id, referencia, clave y event_time
// del evento original y, si se pasa el pedido, su coherencia con el pedido.
export function assessRecovery(key, record, { order = null, orderChecked = false, now = Date.now() } = {}) {
  const prior = priorAttemptOutcome(record);
  const out = {
    recoverable: false,
    reason: "",
    ageSeconds: null,
    eventTime: null,
    priorAttempt: prior.outcome,
    requiresAcknowledgement: prior.ambiguous,
    orderChecked
  };
  const fail = reason => ({ ...out, reason });

  if (!record || typeof record !== "object") return fail("invalid_record");
  if (record.status === "sent") return fail("already_sent");
  if (!["pending", "error", "processing"].includes(String(record.status))) return fail("invalid_status");
  if (record.kind !== "Purchase") return fail("invalid_record");

  const event = record.event;
  if (!event || typeof event !== "object" || event.event_name !== "Purchase") return fail("invalid_record");
  const eventId = String(record.eventId || "");
  if (!eventId || event.event_id !== eventId) return fail("event_id_mismatch");
  if (key !== OUTBOX_PREFIX + eventId.slice(0, 200)) return fail("key_mismatch");
  const reference = String(record.orderReference || "");
  if (!reference || String(event.custom_data?.order_id || "") !== reference) return fail("reference_mismatch");

  const eventTime = Number(event.event_time);
  if (!Number.isInteger(eventTime) || eventTime < 1_000_000_000 || eventTime > 100_000_000_000) {
    return fail("event_time_invalid");
  }
  const age = Math.floor(now / 1000) - eventTime;
  out.eventTime = eventTime;
  out.ageSeconds = age;
  if (age < -FUTURE_TOLERANCE_SECONDS) return fail("event_time_in_future");
  if (age > RECOVERY_MAX_AGE_SECONDS) return fail("expired");

  if (record.status === "processing") {
    const processingAt = Date.parse(String(record.processingAt || ""));
    const stale = Number.isFinite(processingAt) && now - processingAt >= STALE_PROCESSING_MS;
    if (!stale) return fail("in_progress");
  }
  // Un reintento ya programado lo atiende el cron: no se compite con él.
  if (record.nextAttemptAt && Date.parse(String(record.nextAttemptAt)) > now) return fail("retry_scheduled");

  if (orderChecked) {
    if (!order || typeof order !== "object") return fail("order_not_found");
    if (String(order.reference || "") !== reference) return fail("order_reference_mismatch");
    if (order.paymentStatus !== "aprobado") return fail("order_not_approved");
    if (String(order.purchaseEventId || "") !== eventId) return fail("order_event_id_mismatch");
    if (Number(order.confirmedAmount) !== Number(event.custom_data?.value)) return fail("order_amount_mismatch");
  }

  return { ...out, recoverable: true, reason: "ok" };
}

// Solo presencia/formato; nunca valores.
function sendReadiness() {
  const version = String(process.env.META_GRAPH_API_VERSION || "").trim();
  const dataset = String(process.env.META_DATASET_ID || "");
  const tokenPresent = Boolean(process.env.META_CAPI_ACCESS_TOKEN);
  const graphVersionValidFormat = /^v?\d+\.\d+$/.test(version);
  const datasetIdValid = !dataset || /^\d+$/.test(dataset);
  // Con META_TEST_EVENT_CODE el evento iría a "Probar eventos" y quedaría
  // marcado como enviado: se perdería para la recuperación. Se bloquea.
  const testEventCodeActive = Boolean(process.env.META_TEST_EVENT_CODE);
  return {
    tokenPresent,
    graphVersionValidFormat,
    datasetIdValid,
    testEventCodeActive,
    readyToSend: tokenPresent && graphVersionValidFormat && datasetIdValid && !testEventCodeActive
  };
}

function rowFor(key, item, now) {
  const a = assessRecovery(key, item, { now });
  const eventsReceived = numOrNull(item.eventsReceived ?? item.metaResponse?.events_received);
  return {
    key,
    eventId: item.eventId,
    kind: item.kind,
    orderReference: item.orderReference,
    status: item.status,
    attempts: item.attempts,
    nextAttemptAt: item.nextAttemptAt || "",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    sentAt: item.sentAt || "",
    lastError: String(item.lastError || "").slice(0, 240),
    lastMetaStatus: numOrNull(item.lastMetaStatus),
    lastErrorDetail: detailOf(item),
    eventsReceived,
    fbtraceId: String(item.fbtraceId || item.metaResponse?.fbtrace_id || "").slice(0, 80),
    testEventCodeActive: typeof item.testEventCodeActive === "boolean" ? item.testEventCodeActive : null,
    // "sent" sin events_received >= 1: enviado sin confirmación explícita de Meta.
    sentUnverified: item.status === "sent" && !(eventsReceived !== null && eventsReceived >= 1),
    deadLetter: item.status === "error" && !item.nextAttemptAt,
    ageSeconds: a.ageSeconds,
    ageDays: ageDays(a.ageSeconds),
    recoverable: a.recoverable,
    reason: a.reason,
    priorAttempt: a.priorAttempt,
    requiresAcknowledgement: a.requiresAcknowledgement,
    // El GET no lee pedidos: la verificación contra el pedido ocurre en el POST.
    orderChecked: false
  };
}

function buildPlan(key, record, a, config) {
  return {
    ok: true,
    key,
    orderReference: String(record.orderReference || ""),
    eventId: String(record.eventId || ""),
    status: String(record.status || ""),
    attempts: Number(record.attempts || 0),
    ageSeconds: a.ageSeconds,
    ageDays: ageDays(a.ageSeconds),
    eventTime: a.eventTime,
    maxRecoveryAgeDays: RECOVERY_MAX_AGE_SECONDS / 86400,
    lastError: String(record.lastError || "").slice(0, 240),
    lastMetaStatus: numOrNull(record.lastMetaStatus),
    lastErrorDetail: detailOf(record),
    recoverable: a.recoverable,
    reason: a.reason,
    priorAttempt: a.priorAttempt,
    requiresAcknowledgement: a.requiresAcknowledgement,
    orderChecked: a.orderChecked,
    config,
    wouldSend: a.recoverable
      ? { eventName: "Purchase", eventId: String(record.eventId || ""), eventTime: a.eventTime }
      : null
  };
}

async function writeAudit(entry) {
  try {
    const stamp = entry.at.replace(/[^0-9TZ]/g, "");
    const key = AUDIT_PREFIX + stamp + "_" + crypto.randomUUID().slice(0, 8) + "_" + String(entry.eventId).slice(0, 100);
    await store.setJSON(key, entry, { onlyIfNew: true });
  } catch (error) {
    console.error("No se pudo registrar la auditoría de recuperación Meta:", String(error?.name || "Error"));
  }
}

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    const statusFilter = String(new URL(req.url).searchParams.get("status") || "").trim();
    const now = Date.now();
    const { blobs } = await store.list({ prefix: OUTBOX_PREFIX });
    const items = [];
    for (const b of blobs) {
      const item = await store.get(b.key, { type: "json", consistency: "strong" });
      if (!item) continue;
      if (statusFilter && String(item.status) !== statusFilter) continue;
      items.push(rowFor(b.key, item, now));
    }
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const summary = { total: items.length, sent: 0, pending: 0, processing: 0, error: 0, deadLetters: 0, recoverable: 0 };
    for (const it of items) {
      if (Object.hasOwn(summary, it.status)) summary[it.status] += 1;
      if (it.deadLetter) summary.deadLetters += 1;
      if (it.recoverable) summary.recoverable += 1;
    }
    return json({ items, summary, config: sendReadiness() });
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "JSON inválido" }, 400);

  // Recuperación individual y explícita: nada de lotes ni "todos".
  const bulkFields = ["keys", "all", "items", "limit", "status", "statuses"];
  if (Array.isArray(body.key) || bulkFields.some(field => Object.hasOwn(body, field))) {
    return json({ error: "Solo se permite recuperar un evento por solicitud", reason: "bulk_not_allowed" }, 400);
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!KEY_PATTERN.test(key)) return json({ error: "Clave inválida" }, 400);

  // --- Solo lectura hasta que se pase la confirmación ---
  const record = await store.get(key, { type: "json", consistency: "strong" });
  if (!record) return json({ error: "Evento no encontrado", reason: "not_found" }, 404);

  const reference = String(record.orderReference || "");
  const order = REF_PATTERN.test(reference)
    ? await store.get("orders/" + reference, { type: "json", consistency: "strong" })
    : null;
  const now = Date.now();
  const assessment = assessRecovery(key, record, { order, orderChecked: true, now });
  const config = sendReadiness();
  const plan = buildPlan(key, record, assessment, config);

  const confirm = body.confirm === undefined ? null : String(body.confirm);
  if (confirm !== null && confirm !== String(record.eventId || "")) {
    return json({ error: "confirm no coincide con el event_id del evento", reason: "confirm_mismatch" }, 400);
  }
  // dryRun explícito, o ausencia de confirm: nunca envía ni escribe.
  if (body.dryRun === true || confirm === null) return json({ ...plan, dryRun: true });

  // --- Guardas previas al envío real ---
  if (!assessment.recoverable) {
    return json({ ...plan, ok: false, error: "Evento no recuperable", reason: assessment.reason }, 409);
  }
  if (!config.readyToSend) {
    return json({ ...plan, ok: false, error: "Configuración de envío no lista", reason: "send_config_not_ready" }, 409);
  }
  if (assessment.requiresAcknowledgement && body.acknowledgeAmbiguous !== true) {
    return json({
      ...plan,
      ok: false,
      error: "El intento anterior pudo haber llegado a Meta; requiere acknowledgeAmbiguous: true",
      reason: "acknowledgement_required"
    }, 409);
  }

  // processOutboxKey vuelve a leer el registro y reclama con escritura
  // condicional (etag): si el cron u otra solicitud ganaron, devuelve skipped.
  const originalEvent = JSON.stringify(record.event);
  let result = null;
  try { result = await processOutboxKey(key); } catch { /* el detalle queda en el registro */ }
  const after = await store.get(key, { type: "json", consistency: "strong" });

  const outcome = result?.status === "sent"
    ? "sent"
    : result?.skipped ? "skipped_" + result.reason : "error";
  const httpStatus = outcome === "sent" ? 200 : result?.skipped ? 409 : 502;
  const eventsReceived = numOrNull(after?.eventsReceived);
  const detail = detailOf(after);
  const eventUnchanged = JSON.stringify(after?.event) === originalEvent;

  await writeAudit({
    at: new Date().toISOString(),
    mode: "manual",
    key,
    eventId: String(record.eventId || ""),
    orderReference: reference,
    outcome,
    attempts: numOrNull(after?.attempts),
    eventsReceived,
    fbtraceId: String(after?.fbtraceId || detail?.fbtraceId || "").slice(0, 80),
    lastMetaStatus: numOrNull(after?.lastMetaStatus),
    errorCode: detail?.code ?? null,
    errorType: detail?.type || "",
    error: outcome === "sent" ? "" : String(after?.lastError || "").slice(0, 240),
    priorAttempt: assessment.priorAttempt,
    acknowledgedAmbiguous: assessment.requiresAcknowledgement && body.acknowledgeAmbiguous === true,
    ageSeconds: assessment.ageSeconds,
    eventUnchanged
  });

  return json({
    ok: outcome === "sent",
    key,
    eventId: String(record.eventId || ""),
    orderReference: reference,
    outcome,
    status: after?.status || "",
    attempts: numOrNull(after?.attempts),
    eventsReceived,
    fbtraceId: String(after?.fbtraceId || detail?.fbtraceId || "").slice(0, 80),
    lastMetaStatus: numOrNull(after?.lastMetaStatus),
    lastErrorDetail: detail,
    lastError: outcome === "sent" ? "" : String(after?.lastError || "").slice(0, 240),
    eventUnchanged
  }, httpStatus);
};
