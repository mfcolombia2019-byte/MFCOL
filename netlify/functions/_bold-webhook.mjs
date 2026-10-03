import { store, getJson } from "./_admin.mjs";
import { applyBoldPaymentEvent, safeReference } from "./_orders.mjs";
import { enqueuePurchase } from "./_meta-outbox.mjs";

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
    if (!current?.data) throw new Error("Pedido no encontrado para el webhook");

    const boldAmount = Math.round(Number(event?.data?.amount?.total));
    const boldCurrency = String(event?.data?.amount?.currency || "").toUpperCase();
    if (!Number.isFinite(boldAmount) || boldCurrency !== "COP") {
      throw new Error("Importe o moneda de Bold inválidos");
    }
    if (Number(current.data.total) !== boldAmount) {
      throw new Error("El importe de Bold no coincide con el pedido");
    }

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
