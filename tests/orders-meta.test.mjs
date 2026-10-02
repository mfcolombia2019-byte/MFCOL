import assert from "node:assert/strict";
import {
  normalizeClientOrder,
  mergeClientOrder,
  applyBoldPaymentEvent,
  purchaseEventId,
  outboxKeyForPurchase
} from "../netlify/functions/_orders.mjs";
import { validateCart } from "../netlify/functions/_catalog.mjs";
import { buildMetaPurchase } from "../netlify/functions/_meta.mjs";
import {
  validateAdminBoldOrder,
  buildAdminBoldDescription
} from "../netlify/functions/admin-bold.mjs";
import { validateTokenOrder } from "../netlify/functions/comunidad.mjs";

const client = normalizeClientOrder({
  reference: "MF-123",
  totalNumber: 199900,
  name: "Ana",
  paymentStatus: "aprobado",
  status: "entregado",
  fbp: "fb.1.test",
  fbc: "fb.1.click"
}, "2026-10-01T20:00:00.000Z", 199900);

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
}, "2026-10-01T20:01:00.000Z", 199900);

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


const validCart = validateCart([{ id: "mule-de-tacon-alto-con-tres-tiras", size: "36", color: "Negro", qty: 2 }]);
assert.equal(validCart.total, 379800);
assert.equal(validCart.items[0].unitPrice, 189900);

assert.throws(() => validateCart([{ id: "mule-de-tacon-alto-con-tres-tiras", size: "36", color: "Negro", qty: 2, price: 1 }]), /Carrito|Producto|Cantidad|Total|Color|Talla/);
assert.throws(() => validateCart([{ id: "sandalia-de-cuna-trenzada-en-negro-y-rosado", size: "36", color: "Negro", qty: 1 }]), /precio.*configurado/i);
assert.throws(() => validateCart([{ id: "mule-de-tacon-alto-con-tres-tiras", size: "33", color: "Negro", qty: 1 }]), /Talla inválida/);

console.log("checkout server-authority tests: PASS");


const pendingOrder = {
  reference: "MF-BOLD-1",
  paymentStatus: "pendiente",
  paymentMethod: "Link de pago (Bold)",
  total: 239900,
  items: [{ id: "shoe-1", name: "Plataforma Elevé" }]
};
const adminValidated = validateAdminBoldOrder(pendingOrder, "MF-BOLD-1");
assert.equal(adminValidated.total, 239900);
assert.equal(buildAdminBoldDescription(pendingOrder), "MF Colombia · Plataforma Elevé");

// Client-supplied total is not a source of truth: the validation helper only reads order.total.
assert.equal(adminValidated.total, pendingOrder.total);
assert.notEqual(adminValidated.total, 1234);
assert.match(validateAdminBoldOrder(null, "MF-BOLD-404").error, /Pedido no encontrado/);
assert.match(validateAdminBoldOrder(pendingOrder, "").error, /referencia.*obligatoria/i);
assert.match(validateAdminBoldOrder({ ...pendingOrder, paymentStatus: "aprobado" }, "MF-BOLD-1").error, /ya no está pendiente/i);
assert.match(validateAdminBoldOrder({ ...pendingOrder, paymentMethod: "Transferencia bancaria" }, "MF-BOLD-1").error, /Bold/i);

const approvedToken = {
  orderRef: "MF-APPROVED-1",
  products: [{ id: "shoe-1", name: "Plataforma Elevé" }]
};
const approvedOrder = {
  reference: "MF-APPROVED-1",
  paymentStatus: "aprobado",
  items: [{ id: "shoe-1", name: "Plataforma Elevé" }]
};
assert.equal(validateTokenOrder(approvedToken, approvedOrder, "shoe-1").orderRef, "MF-APPROVED-1");
assert.match(validateTokenOrder(approvedToken, { ...approvedOrder, paymentStatus: "pendiente" }, "shoe-1").error, /no está confirmada/i);
assert.match(validateTokenOrder({ ...approvedToken, orderRef: "MF-WRONG" }, approvedOrder, "shoe-1").error, /Pedido no encontrado/i);
assert.match(validateTokenOrder(approvedToken, { ...approvedOrder, items: [{ id: "other", name: "Otro" }] }, "shoe-1").error, /producto no pertenece/i);
assert.match(validateTokenOrder(approvedToken, null, "shoe-1").error, /Pedido no encontrado/i);
assert.match(validateTokenOrder(approvedToken, approvedOrder, "other").error, /producto no pertenece/i);

console.log("security/orders-meta-capi targeted tests: PASS");
