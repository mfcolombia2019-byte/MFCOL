const SAFE_REF = /^[A-Za-z0-9_-]{1,80}$/;

export const PAYMENT_STATUSES = new Set(["pendiente", "aprobado", "rechazado", "anulado"]);

export function safeReference(value) {
  const ref = String(value ?? "").trim();
  return SAFE_REF.test(ref) ? ref : "";
}

export function cleanText(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

export function cleanTrackingValue(value, max = 500) {
  const v = String(value ?? "").trim();
  return v ? v.slice(0, max) : "";
}

export function normalizeClientOrder(input, now = new Date().toISOString(), serverTotal) {
  const reference = safeReference(input?.reference);
  if (!reference) throw new Error("Referencia inválida");

  const total = Math.round(Number(serverTotal));
  if (!Number.isFinite(total) || total < 1000 || total > 20000000) {
    throw new Error("Total validado por servidor inválido");
  }

  return {
    reference,
    createdAt: cleanText(input?.createdAt, 60) || now,
    updatedAt: now,
    name: cleanText(input?.name, 120),
    address: cleanText(input?.address, 240),
    city: cleanText(input?.city, 100),
    phone: cleanText(input?.phone, 40),
    pedido: cleanText(input?.pedido, 5000),
    items: Array.isArray(input?.items) ? input.items.slice(0, 50) : [],
    total,
    totalFormatted: cleanText(input?.totalFormatted, 80),
    paymentMethod: cleanText(input?.paymentMethod || "por definir", 80),
    paymentLink: cleanText(input?.paymentLink, 500),
    boldPaymentLink: cleanText(input?.boldPaymentLink, 120),
    status: "nuevo",
    paymentStatus: "pendiente",
    notes: cleanText(input?.notes, 2000),
    fbp: cleanTrackingValue(input?.fbp, 500),
    fbc: cleanTrackingValue(input?.fbc, 500),
    clientUserAgent: cleanTrackingValue(input?.clientUserAgent, 1000),
    eventSourceUrl: cleanTrackingValue(input?.eventSourceUrl, 1000)
  };
}

export function mergeClientOrder(existing, incoming, now = new Date().toISOString(), serverTotal) {
  if (!existing && !Number.isFinite(Number(serverTotal))) {
    throw new Error("Falta el importe validado por servidor");
  }
  const base = normalizeClientOrder(incoming, now, existing ? Number(existing.total) : serverTotal);
  if (!existing) return base;

  return {
    ...existing,
    reference: base.reference,
    createdAt: existing.createdAt || base.createdAt,
    updatedAt: now,
    name: base.name || existing.name || "",
    address: base.address || existing.address || "",
    city: base.city || existing.city || "",
    phone: base.phone || existing.phone || "",
    pedido: base.pedido || existing.pedido || "",
    items: Array.isArray(existing.items) && existing.items.length ? existing.items : base.items,
    // Never replace an existing order amount with a browser-supplied value.
    total: Number(existing.total),
    totalFormatted: base.totalFormatted || existing.totalFormatted || "",
    paymentMethod: base.paymentMethod || existing.paymentMethod || "por definir",
    paymentLink: base.paymentLink || existing.paymentLink || "",
    boldPaymentLink: base.boldPaymentLink || existing.boldPaymentLink || "",
    status: existing.status || "nuevo",
    paymentStatus: PAYMENT_STATUSES.has(existing.paymentStatus) ? existing.paymentStatus : "pendiente",
    notes: existing.notes || base.notes || "",
    fbp: base.fbp || existing.fbp || "",
    fbc: base.fbc || existing.fbc || "",
    clientUserAgent: base.clientUserAgent || existing.clientUserAgent || "",
    eventSourceUrl: base.eventSourceUrl || existing.eventSourceUrl || ""
  };
}

export function paymentStatusForBoldType(type) {
  switch (String(type || "")) {
    case "SALE_APPROVED": return "aprobado";
    case "SALE_REJECTED": return "rechazado";
    case "VOID_APPROVED": return "anulado";
    case "VOID_REJECTED": return "rechazado";
    default: return "pendiente";
  }
}

export function applyBoldPaymentEvent(existing, event, now = new Date().toISOString()) {
  const d = event?.data || {};
  const type = String(event?.type || "").trim();
  const next = { ...(existing || {}) };
  const current = PAYMENT_STATUSES.has(next.paymentStatus) ? next.paymentStatus : "pendiente";
  const confirmedAmount = Math.round(Number(d.amount?.total));

  // Never let a later client/admin-like value downgrade an already approved
  // payment. Payment approval itself only comes from this validated Bold path.
  let paymentStatus = paymentStatusForBoldType(type);
  if (current === "aprobado" && (type === "SALE_REJECTED" || type === "VOID_REJECTED")) {
    paymentStatus = "aprobado";
  }
if (current === "anulado" && type === "SALE_APPROVED") {
    const currentPaymentId = cleanText(next.paymentId || "", 120);
    const incomingPaymentId = cleanText(d.payment_id || event?.subject, 120);

    if (currentPaymentId && incomingPaymentId && currentPaymentId === incomingPaymentId) {
      paymentStatus = "anulado";
    }
  }
  next.updatedAt = now;
  next.paymentStatus = paymentStatus;
  next.paymentId = cleanText(d.payment_id || event?.subject, 120);
  next.boldPaymentMethod = cleanText(d.payment_method, 80);
  next.boldCode = cleanText(d.bold_code, 80);
  next.payerEmail = cleanText(d.payer_email, 160);
  next.boldCreatedAt = cleanText(d.created_at, 80);
  next.webhookType = type;
  next.webhookEventId = cleanText(event?.id, 120);
  next.paymentEventTime = Number.isFinite(Number(event?.time))
    ? Math.floor(Number(event.time) / 1e9)
    : Math.floor(Date.now() / 1000);
  next.purchaseEventId = purchaseEventId(next.reference, next.paymentId, next.webhookEventId);

  if (Number.isFinite(confirmedAmount) && confirmedAmount >= 0) {
    next.confirmedAmount = confirmedAmount;
    next.confirmedCurrency = cleanText(d.amount?.currency || "COP", 8);
  }

  return next;
}

export function purchaseEventId(reference, paymentId, eventId) {
  const r = safeReference(reference);
  const p = cleanText(paymentId, 120).replace(/[^A-Za-z0-9_-]/g, "");
  const e = cleanText(eventId, 120).replace(/[^A-Za-z0-9_-]/g, "");
  return ("purchase_" + r + "_" + (p || e)).slice(0, 200);
}

export function outboxKeyForPurchase(reference, paymentId, eventId) {
  return "meta-outbox/" + purchaseEventId(reference, paymentId, eventId).slice(0, 200);
}
