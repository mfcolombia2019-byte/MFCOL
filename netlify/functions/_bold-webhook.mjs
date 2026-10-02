import { store, getJson } from "./_admin.mjs";
import { applyBoldPaymentEvent, safeReference } from "./_orders.mjs";
import { enqueuePurchase } from "./_meta-outbox.mjs";

export function safeEventId(id) {
  const value = String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
  return value || "";
}

export function webhookInboxKey(eventId) {
  return "webhook-inbox/" + safeEventId(eventId);
}

export async function processBoldWebhook(event) {
  const eventId = safeEventId(event?.id);
  if (!eventId) throw new Error("Evento Bold sin id");

  const inboxKey = webhookInboxKey(eventId);
  const inbox = await store.get(inboxKey, { type: "json", consistency: "strong" });
  if (!inbox) throw new Error("Evento Bold no encontrado en inbox");
  if (inbox.processedAt) return { ok: true, duplicate: true, reference: inbox.reference || "" };

  const d = event.data || {};
  const reference = safeReference(d.metadata?.reference);
  const now = new Date().toISOString();
  let outboxResult = null;

  if (reference) {
    const existing = await getJson("orders/" + reference);
    const order = applyBoldPaymentEvent(existing || {
      reference,
      createdAt: now,
      name: "",
      address: "",
      city: "",
      phone: "",
      pedido: "",
      total: Number(d.amount?.total || 0),
      totalFormatted: "",
      paymentMethod: String(d.payment_method || ""),
      paymentLink: "",
      boldPaymentLink: "",
      status: "nuevo",
      paymentStatus: "pendiente",
      notes: "",
      fbp: "",
      fbc: "",
      clientUserAgent: "",
      eventSourceUrl: ""
    }, event, now);

    // Keep client attribution fields already saved on the order. They are never
    // replaced by webhook payloads from Bold.
    await store.setJSON("orders/" + reference, order);

    if (event.type === "SALE_APPROVED") {
      outboxResult = await enqueuePurchase(order);
    }
  }

  // This marker is deliberately written last. If order persistence or outbox
  // creation fails, the event remains unprocessed and can be recovered.
  inbox.reference = reference;
  inbox.status = "processed";
  inbox.processedAt = now;
  inbox.updatedAt = now;
  await store.setJSON(inboxKey, inbox);

  return { ok: true, duplicate: false, reference, outboxKey: outboxResult?.key || "" };
}
