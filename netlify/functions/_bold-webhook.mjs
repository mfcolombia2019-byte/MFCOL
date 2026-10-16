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

// Diagnóstico de esquema sin registrar datos personales ni el cuerpo completo del webhook.
function describeEventShape(event) {
  const data = event?.data;
  const candidates = [
    ["data.amount.total", data?.amount?.total],
    ["data.total", data?.total],
    ["data.transaction.amount", data?.transaction?.amount],
    ["data.transaction.amount.total", data?.transaction?.amount?.total],
    ["data.payment.amount", data?.payment?.amount],
    ["data.payment.amount.total", data?.payment?.amount?.total],
    ["data.amount.value", data?.amount?.value]
  ];
  return {
    eventId: safeEventId(event?.id),
    eventType: String(event?.type || "").slice(0, 40),
    topLevelKeys: Object.keys(event || {}).sort().slice(0, 40),
    dataKeys: Object.keys(data || {}).sort().slice(0, 60),
    amountKeys: Object.keys(data?.amount || {}).sort().slice(0, 30),
    metadataKeys: Object.keys(data?.metadata || {}).sort().slice(0, 30),
    amountCandidates: candidates.filter(([, value]) => value !== undefined).map(([path, value]) => ({ path, type: valueType(value), value: rawValue(value) }))
  };
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

// Cuando Bold entrega total=0 en el webhook, no se aprueba a ciegas: se consulta
// el voucher autenticado y se exige estado, referencia, transacción e importe exactos.
async function recoverAmountFromVoucher(orderData, event, reference) {
  const raw = parseAmount(event?.data?.amount?.total);
  if (Number.isFinite(raw) && raw > 0) return event;
  const apiKey = String(process.env.BOLD_API_KEY || "").trim();
  if (!apiKey) return event;
  let response;
  try {
    response = await fetch("https://payments.api.bold.co/v2/payment-voucher/" + encodeURIComponent(reference), {
      method: "GET",
      headers: { Authorization: "x-api-key " + apiKey },
      signal: AbortSignal.timeout(8000)
    });
  } catch (error) {
    logBoldEvent("error", "bold_webhook_voucher_recovery_failed", { reference, reason: String(error?.name || "network_error") });
    return event;
  }
  if (!response.ok) {
    logBoldEvent("error", "bold_webhook_voucher_recovery_failed", { reference, httpStatus: response.status });
    return event;
  }
  const voucher = await response.json().catch(() => null);
  const voucherReference = String(voucher?.reference_id ?? "").trim();
  const transactionId = String(voucher?.transaction_id ?? "").trim();
  const expectedTransaction = String(event?.data?.payment_id || event?.subject || "").trim();
  const amount = parseAmount(voucher?.total);
  const expectedAmount = parseAmount(orderData?.total);
  if (
    String(voucher?.payment_status || "").toUpperCase() !== "APPROVED" ||
    !voucherReference || voucherReference !== reference ||
    !transactionId ||
    !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(expectedAmount) || amount !== expectedAmount
  ) {
    logBoldEvent("error", "bold_webhook_voucher_recovery_rejected", {
      reference,
      status: String(voucher?.payment_status || "").slice(0, 20),
      referenceMatched: Boolean(voucherReference && voucherReference === reference),
      voucherTransactionPresent: Boolean(transactionId),
      eventTransactionDiffers: Boolean(expectedTransaction && transactionId && transactionId !== expectedTransaction),
      amountMatched: Number.isFinite(amount) && Number.isFinite(expectedAmount) && amount === expectedAmount
    });
    return event;
  }
  logBoldEvent("warn", "bold_webhook_amount_recovered_from_voucher", { reference, transactionId, amount });
  return {
    ...event,
    data: { ...event.data, payment_id: transactionId, amount: { currency: "COP", total: amount }, metadata: { ...event.data?.metadata, reference } }
  };
}

// Valida importe y moneda del evento contra el total persistido del pedido.
// No relaja nada: solo distingue la causa y deja los valores comparados.
export function validateBoldAmount(orderData, event, reference) {
  const details = describeAmounts(reference, event, orderData);
  if (details.boldTotal === null || details.boldTotal === 0) {
    logBoldEvent("error", "bold_webhook_amount_schema_diagnostic", describeEventShape(event));
  }
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

    const verifiedEvent = await recoverAmountFromVoucher(current.data, event, reference);
    validateBoldAmount(current.data, verifiedEvent, reference);

    const order = applyBoldPaymentEvent(current.data, verifiedEvent, new Date().toISOString());
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
