import assert from "node:assert/strict";
import {
  normalizeClientOrder,
  mergeClientOrder,
  applyBoldPaymentEvent,
  purchaseEventId,
  outboxKeyForPurchase
} from "../netlify/functions/_orders.mjs";
import { buildMetaPurchase } from "../netlify/functions/_meta.mjs";

const client = normalizeClientOrder({
  reference: "MF-123",
  totalNumber: 199900,
  name: "Ana",
  paymentStatus: "aprobado",
  status: "entregado",
  fbp: "fb.1.test",
  fbc: "fb.1.click"
}, "2026-10-01T20:00:00.000Z");

assert.equal(client.paymentStatus, "pendiente");
assert.equal(client.status, "nuevo");
assert.equal(client.fbp, "fb.1.test");
assert.equal(client.fbc, "fb.1.click");

const existing = {
  ...client,
  paymentStatus: "aprobado",
  status: "preparando",
  fbp: "fb.1.original",
  fbc: "fb.1.original-click"
};

const merged = mergeClientOrder(existing, {
  reference: "MF-123",
  totalNumber: 199900,
  name: "Ana",
  paymentStatus: "rechazado",
  status: "cancelado"
}, "2026-10-01T20:01:00.000Z");

assert.equal(merged.paymentStatus, "aprobado");
assert.equal(merged.status, "preparando");
assert.equal(merged.fbp, "fb.1.original");
assert.equal(merged.fbc, "fb.1.original-click");

const approvedEvent = {
  id: "evt-1",
  type: "SALE_APPROVED",
  subject: "PAY-1",
  time: 1761063334000000000,
  data: {
    payment_id: "PAY-1",
    amount: { currency: "COP", total: 199900 },
    metadata: { reference: "MF-123" },
    payment_method: "CARD_WEB"
  }
};

const approved = applyBoldPaymentEvent({
  ...merged,
  reference: "MF-123",
  fbp: "fb.1.original",
  fbc: "fb.1.original-click"
}, approvedEvent, "2026-10-01T20:02:00.000Z");

assert.equal(approved.paymentStatus, "aprobado");
assert.equal(approved.webhookType, "SALE_APPROVED");
assert.equal(approved.confirmedAmount, 199900);
assert.equal(approved.confirmedCurrency, "COP");
assert.equal(approved.purchaseEventId, purchaseEventId("MF-123", "PAY-1", "evt-1"));

const purchase = buildMetaPurchase(approved);
assert.equal(purchase.event_name, "Purchase");
assert.equal(purchase.action_source, "website");
assert.equal(purchase.custom_data.currency, "COP");
assert.equal(purchase.custom_data.value, 199900);
assert.equal(purchase.event_id, approved.purchaseEventId);
assert.equal(purchase.user_data.fbp, "fb.1.original");
assert.equal(purchase.user_data.fbc, "fb.1.original-click");
assert.equal(purchase.event_time, Math.floor(1761063334000000000 / 1e9));

assert.throws(() => buildMetaPurchase({
  ...approved,
  paymentStatus: "pendiente",
  webhookType: "SALE_REJECTED"
}), /SALE_APPROVED/);

assert.throws(() => buildMetaPurchase({
  ...approved,
  paymentStatus: "aprobado",
  webhookType: "SALE_APPROVED",
  confirmedAmount: undefined
}), /importe confirmado/);

const whatsappOrder = {
  ...approved,
  paymentStatus: "pendiente",
  webhookType: "",
  paymentMethod: "Transferencia bancaria"
};
assert.throws(() => buildMetaPurchase(whatsappOrder), /SALE_APPROVED/);

assert.equal(
  outboxKeyForPurchase("MF-123", "PAY-1", "evt-1"),
  outboxKeyForPurchase("MF-123", "PAY-1", "evt-1")
);

const rejectedAfterApproved = applyBoldPaymentEvent(approved, {
  id: "evt-2",
  type: "SALE_REJECTED",
  data: {
    payment_id: "PAY-1",
    amount: { currency: "COP", total: 199900 },
    metadata: { reference: "MF-123" }
  }
});
assert.equal(rejectedAfterApproved.paymentStatus, "aprobado");

console.log("orders-meta tests: PASS");
