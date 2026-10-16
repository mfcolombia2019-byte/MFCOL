import { store, getJson } from "./_admin.mjs";
import { applyBoldPaymentEvent, safeReference } from "./_orders.mjs";
import { enqueuePurchase } from "./_meta-outbox.mjs";
import { BoldWebhookError, buildInboxFailure, logBoldEvent } from "./_bold-failure.mjs";

export { BoldWebhookError, buildInboxFailure, logBoldEvent, inboxRetryDelayMs, MAX_INBOX_ATTEMPTS } from "./_bold-failure.mjs";

// Estricto: solo números finitos o texto numérico. null, "", booleanos, arreglos
// y objetos dan NaN (Number(null) y Number("") serían 0 y se leerían como un
// importe real de 0).
export function parseAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string") {
    const text = value.trim();
    return /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  }
  return NaN;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function rawValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value.slice(0, 32);
  return valueType(value);
}

// Solo importes, moneda, referencia e ids de evento.
function describeAmounts(reference, event, orderData) {
  const amount = event?.data?.amount;
  const bold = parseAmount(amount?.total);
  const expected = parseAmount(orderData?.total);
  const boldTotal = Number.isFinite(bold) ? Math.round(bold) : null;
  const orderTotal = Number.isFinite(expected) ? expected : null;
  return {
    reference,
    eventId: safeEventId(event?.id),
    eventType: String(event?.type || "").slice(0, 40),
    currency: String(amount?.currency ?? "").toUpperCase().slice(0, 8),
    boldTotalRaw: rawValue(amount?.total),
    boldTotalType: valueType(amount?.total),
    boldTotal,
    orderTotalRaw: rawValue(orderData?.total),
    orderTotalType: valueType(orderData?.total),
    orderTotal,
    difference: boldTotal !== null && orderTotal !== null ? boldTotal - orderTotal : null,
    orderPaymentStatus: String(orderData?.paymentStatus || "").slice(0, 20)
  };
}

function rejectAmount(code, message, details) {
  logBoldEvent("error", "bold_webhook_amount_rejected", { code, ...details });
  return new BoldWebhookError(code, message, { retryable: false, details });
}

// Valida importe y moneda del evento contra el total persistido del pedido.
// No relaja nada: solo distingue la causa y deja los valores comparados.
export function validateBoldAmount(orderData, event, reference) {
  const details = describeAmounts(reference, event, orderData);
  if (details.boldTotal === null) {
    throw rejectAmount("AMOUNT_INVALID", "Importe o moneda de Bold inválidos", details);
  }
  if (details.currency !== "COP") {
    throw rejectAmount("CURRENCY_INVALID", "Importe o moneda de Bold inválidos", details);
  }
  if (details.orderTotal === null) {
    throw rejectAmount("ORDER_TOTAL_INVALID", "El pedido no tiene un total numérico válido para validar el importe de Bold", details);
  }
  if (details.boldTotal !== details.orderTotal) {
    throw rejectAmount("AMOUNT_MISMATCH", "El importe de Bold no coincide con el pedido", details);
  }
  return details.boldTotal;
}

export async function recordInboxFailure(key, error) {
  const latest = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!latest?.data || latest.data.processedAt) return null;
  const failed = buildInboxFailure(latest.data, error);
  const written = await store.setJSON(key, failed, { onlyIfMatch: latest.etag });
  if (written?.modified && !written?.etag) {
    throw new Error("No se pudo confirmar el estado de reintento del inbox Bold");
  }
  return failed;
}

function conditionalWriteSucceeded(result) {
  if (!result?.modified) return false;
  if (!result?.etag) throw new Error("La escritura condicional de Blobs no pudo confirmarse");
  return true;
}

export function safeEventId(id) {
  const value = String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
  return value || "";
}

export function webhookInboxKey(eventId) {
  return "webhook-inbox/" + safeEventId(eventId);
}
const WEBHOOK_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
async function ensureInbox(event) {
  const eventId = safeEventId(event?.id);
  const key = webhookInboxKey(eventId);
  const now = new Date().toISOString();
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (current?.data) return current;

  const result = await store.setJSON(key, {
    id: eventId,
    type: String(event.type),
    receivedAt: now,
    updatedAt: now,
    status: "pending",
    processedAt: "",
    processingAt: "",
    reference: "",
    event
  }, { onlyIfNew: true });
  if (result?.modified && !result?.etag) throw new Error("No se pudo confirmar el inbox de Bold");
  return await store.getWithMetadata(key, { type: "json", consistency: "strong" });
}

async function claimInbox(eventId) {
  const key = webhookInboxKey(eventId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!current?.data) throw new Error("Evento Bold no encontrado en inbox");
    if (current.data.processedAt) return { claimed: false, duplicate: true, current };
    if (current.data.status === "processing") {
  const processingAt = Date.parse(String(current.data.processingAt || ""));
  const abandoned =
    Number.isFinite(processingAt) &&
    (Date.now() - processingAt) >= WEBHOOK_PROCESSING_TIMEOUT_MS;

  if (!abandoned) return { claimed: false, busy: true, current };
}
    const next = {
      ...current.data,
      status: "processing",
      processingAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const result = await store.setJSON(key, next, { onlyIfMatch: current.etag });
    if (result?.modified && !result?.etag) throw new Error("No se pudo confirmar el bloqueo del webhook");
    if (result?.modified) return { claimed: true, current: next };
  }
  return { claimed: false, busy: true };
}

async function resolveReference(event) {
  const raw = safeReference(event?.data?.metadata?.reference);
  if (!raw) return "";
  if (raw.startsWith("LNK_")) {
    const mapping = await getJson("bold-links/" + raw);
    return safeReference(mapping?.reference);
  }
  return raw;
}

async function updateOrderFromWebhook(reference, event) {
  const key = "orders/" + reference;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
    if (!current?.data) {
      throw new BoldWebhookError("ORDER_NOT_FOUND", "Pedido no encontrado para el webhook", {
        retryable: true,
        details: { reference, eventId: safeEventId(event?.id), eventType: String(event?.type || "").slice(0, 40) }
      });
    }

    validateBoldAmount(current.data, event, reference);

    const order = applyBoldPaymentEvent(current.data, event, new Date().toISOString());
    const result = await store.setJSON(key, order, { onlyIfMatch: current.etag });
    if (result?.modified && !result?.etag) throw new Error("No se pudo confirmar la actualización del pedido");
    if (result?.modified) return order;
  }
  throw new Error("El pedido cambió durante el procesamiento del webhook");
}

export async function processBoldWebhook(event) {
  const eventId = safeEventId(event?.id);
  if (!eventId) throw new Error("Evento Bold sin id");

  await ensureInbox(event);
  const claim = await claimInbox(eventId);
  if (claim.duplicate) return { ok: true, duplicate: true, reference: claim.current?.reference || "" };
  if (!claim.claimed) return { ok: true, busy: true, reference: claim.current?.reference || "" };

  const reference = await resolveReference(event);
  if (!reference) throw new Error("Webhook Bold sin referencia resoluble");

  const order = await updateOrderFromWebhook(reference, event);
  let outboxResult = null;
  if (event.type === "SALE_APPROVED") outboxResult = await enqueuePurchase(order);

  const inboxKey = webhookInboxKey(eventId);
  const inbox = await getJson(inboxKey);
  if (!inbox) throw new Error("Inbox desapareció durante el procesamiento");
  inbox.reference = reference;
  inbox.status = "processed";
  inbox.processedAt = new Date().toISOString();
  inbox.updatedAt = inbox.processedAt;
  await store.setJSON(inboxKey, inbox);

  return { ok: true, duplicate: false, reference, outboxKey: outboxResult?.key || "" };
}

export { ensureInbox };
