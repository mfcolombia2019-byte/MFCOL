import { getStore } from "@netlify/blobs";
import { buildMetaPurchase, sendMetaEvent } from "./_meta.mjs";
import { outboxKeyForPurchase } from "./_orders.mjs";

const outbox = getStore("mfc-admin");

function nowIso() { return new Date().toISOString(); }

function retryDelayMs(attempts) {
  return Math.min(60 * 60 * 1000, Math.max(30 * 1000, 2 ** Math.max(0, attempts - 1) * 30 * 1000));
}

function conditionalOk(result) {
  if (!result?.modified) return false;
  if (!result?.etag) throw new Error("La escritura condicional del outbox no pudo confirmarse");
  return true;
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
  if (current.data.status === "processing") {
    return { ok: false, skipped: true, reason: "busy", key };
  }

  const now = Date.now();
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
      processingAt: "",
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
    const failed = {
      ...latest.data,
      status: "error",
      updatedAt: nowIso(),
      processingAt: "",
      lastError: String(error?.message || error).slice(0, 1000),
      nextAttemptAt: retryable && attempts < maxAttempts
        ? new Date(Date.now() + retryDelayMs(attempts)).toISOString()
        : ""
    };
    const written = await outbox.setJSON(key, failed, { onlyIfMatch: latest.etag });
    if (written?.modified && !written?.etag) throw new Error("No se pudo confirmar el error del outbox");
    if (!written?.modified) return { ok: false, skipped: true, reason: "lost_race", key };
    if (retryable && attempts < maxAttempts) throw error;
    return { ok: false, key, status: "error", attempts, retryable: false };
  }
}
