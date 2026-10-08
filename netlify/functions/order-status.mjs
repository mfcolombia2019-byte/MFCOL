import { store, json } from "./_admin.mjs";
import { applyBoldPaymentEvent } from "./_orders.mjs";
import { enqueuePurchase } from "./_meta-outbox.mjs";
import { enqueueWhatsAppConfirmation, processWhatsAppOutboxKey } from "./_whatsapp.mjs";

const REF = /^[A-Za-z0-9_-]{1,80}$/;

function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify?.env?.get) {
      const value = Netlify.env.get(name);
      if (value) return String(value).trim();
    }
  } catch {}
  return String(process.env[name] || "").trim();
}

async function reconcileBoldLink(order) {
  const paymentLink = String(order?.boldPaymentLink || "").trim();
  const apiKey = env("BOLD_API_KEY");
  if (!paymentLink || !apiKey) return order;

  const response = await fetch(
    "https://integrations.api.bold.co/online/link/v1/" + encodeURIComponent(paymentLink),
    { method: "GET", headers: { Authorization: "x-api-key " + apiKey } }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Bold status fallback:", response.status, JSON.stringify(data));
    return order;
  }

  const status = String(data?.status || "").toUpperCase();
  if (!["PAID", "REJECTED", "CANCELLED"].includes(status)) return order;

  const amount = Math.round(Number(data?.total));
  if (!Number.isFinite(amount) || amount !== Number(order.total)) {
    console.error("Bold status fallback: importe no coincide", {
      reference: order.reference,
      expected: order.total,
      received: data?.total
    });
    return order;
  }

  const type = status === "PAID" ? "SALE_APPROVED" : "SALE_REJECTED";
  const transactionId = String(data?.transaction_id || data?.id || paymentLink).trim();
  const event = {
    id: "poll_" + paymentLink + "_" + status + "_" + transactionId,
    type,
    subject: transactionId,
    source: "/payments/links",
    spec_version: "1.0",
    time: Date.now() * 1000000,
    data: {
      payment_id: transactionId,
      amount: { currency: "COP", total: amount },
      metadata: { reference: paymentLink },
      payment_method: String(data?.payment_method || "LINK"),
      bold_code: "",
      payer_email: "",
      created_at: "",
      integration: "LINK"
    }
  };

  if (order.paymentStatus === "aprobado" && type !== "SALE_APPROVED") return order;
  if (order.paymentStatus === "rechazado" && type === "SALE_REJECTED") return order;

  const current = await store.getWithMetadata("orders/" + order.reference, {
    type: "json",
    consistency: "strong"
  });
  if (!current?.data || current.data.paymentStatus !== "pendiente") {
    return current?.data || order;
  }

  const next = applyBoldPaymentEvent(current.data, event, new Date().toISOString());
  const saved = await store.setJSON(
    "orders/" + order.reference,
    next,
    { onlyIfMatch: current.etag }
  );
  if (!saved?.modified) {
    return await store.get("orders/" + order.reference, {
      type: "json",
      consistency: "strong"
    }) || order;
  }

  if (type === "SALE_APPROVED") {
    try {
      await enqueuePurchase(next);
    } catch (error) {
      console.error("No se pudo encolar Purchase desde fallback Bold:", error);
    }
    try {
      const outbox = await enqueueWhatsAppConfirmation(next);
      if (outbox?.key) await processWhatsAppOutboxKey(outbox.key);
    } catch (error) {
      console.error("No se pudo enviar WhatsApp desde fallback Bold:", error);
    }
  }

  return next;
}

export default async (req) => {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);

  const ref = String(new URL(req.url).searchParams.get("ref") || "").trim();
  if (!REF.test(ref)) return json({ error: "Referencia inválida" }, 400);

  let order = await store.get("orders/" + ref, { type: "json", consistency: "strong" });
  if (!order) return json({ error: "Pedido no encontrado" }, 404);

  if (order.paymentStatus === "pendiente" && order.boldPaymentLink) {
    try {
      order = await reconcileBoldLink(order);
    } catch (error) {
      console.error("No se pudo consultar el estado de Bold:", error);
    }
  }

  return json({
    reference: order.reference,
    paymentStatus: order.paymentStatus || "pendiente",
    status: order.status || "nuevo",
    total: Number(order.total) || 0,
    paymentLink: order.paymentLink || "",
    boldPaymentLink: order.boldPaymentLink || ""
  });
};
