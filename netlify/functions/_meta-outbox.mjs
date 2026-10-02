import { getStore } from "@netlify/blobs";
import { buildMetaPurchase, sendMetaPurchase } from "./_meta.mjs";
import { outboxKeyForPurchase } from "./_orders.mjs";

const outbox = getStore("mfc-admin");

function nowIso() { return new Date().toISOString(); }

function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, Math.max(30 * 1000, 2 ** Math.max(0, attempts - 1) * 30 * 1000));
}

export async function enqueuePurchase(order) {
  const event = buildMetaPurchase(order);
  const eventId = event.event_id;
  const key = outboxKeyForPurchase(order.reference, order.paymentId, order.webhookEventId);

  const existing = await outbox.get(key, { type: "json", consistency: "strong" });
  if (existing?.status === "sent") {
    return { key, created: false, status: "sent", eventId };
  }

  const record = {
    key,
    kind: "Purchase",
    eventId,
    orderReference: String(order.reference || ""),
    status: existing?.status === "error" ? "pending" : (existing?.status || "pending"),
    attempts: Number(existing?.attempts || 0),
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
    nextAttemptAt: nowIso(),
    lastError: existing?.lastError || "",
    event
  };

  await outbox.setJSON(key, record);
  return { key, created: !existing, status: record.status, eventId };
}

export async function processOutboxKey(key) {
  const record = await outbox.get(key, { type: "json", consistency: "strong" });
  if (!record) return { ok: false, skipped: true, reason: "not_found" };
  if (record.status === "sent") return { ok: true, skipped: true, reason: "sent", key };

  const now = Date.now();
  if (record.nextAttemptAt && new Date(record.nextAttemptAt).getTime() > now) {
    return { ok: false, skipped: true, reason: "not_due", key };
  }

  // Best-effort lease only. @netlify/blobs 8.1.0 has no conditional writes,
  // so this is not a cross-instance lock.
  const attempts = Number(record.attempts || 0) + 1;
  record.status = "processing";
  record.attempts = attempts;
  record.updatedAt = nowIso();
  await outbox.setJSON(key, record);

  try {
    const result = await sendMetaPurchase({
      ...record.event,
      paymentStatus: "aprobado"
    }.paymentStatus ? recordToOrder(record) : recordToOrder(record));

    record.status = "sent";
    record.updatedAt = nowIso();
    record.sentAt = record.updatedAt;
    record.nextAttemptAt = "";
    record.lastError = "";
    record.metaResponse = result.response;
    await outbox.setJSON(key, record);
    return { ok: true, key, status: "sent", attempts };
  } catch (error) {
    const retryable = Number(error?.metaStatus) === 429 || Number(error?.metaStatus) >= 500 || !error?.metaStatus;
    const maxAttempts = 8;
    record.status = "error";
    record.updatedAt = nowIso();
    record.lastError = String(error?.message || error).slice(0, 1000);
    record.nextAttemptAt = attempts < maxAttempts
      ? new Date(Date.now() + retryDelayMs(attempts)).toISOString()
      : "";
    await outbox.setJSON(key, record);

    if (retryable && attempts < maxAttempts) throw error;
    return { ok: false, key, status: "error", attempts, retryable: false };
  }
}

function recordToOrder(record) {
  const e = record.event || {};
  return {
    reference: record.orderReference,
    paymentId: record.paymentId || "",
    webhookEventId: record.webhookEventId || "",
    purchaseEventId: e.event_id,
    paymentStatus: "aprobado",
    webhookType: "SALE_APPROVED",
    paymentEventTime: e.event_time,
    eventSourceUrl: e.event_source_url || "",
    confirmedAmount: e.custom_data?.value,
    confirmedCurrency: e.custom_data?.currency || "COP",
    fbp: e.user_data?.fbp || "",
    fbc: e.user_data?.fbc || "",
    name: "",
    phone: ""
  };
}
