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

const BOLD_FALLBACK_COOLDOWN_MS = 15000;

async function claimBoldFallbackCheck(reference) {
  const key = "bold-fallback-checks/" + reference;
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  const lastCheckedAt = Date.parse(String(current?.data?.checkedAt || ""));
  const now = Date.now();
  if (Number.isFinite(lastCheckedAt) && now - lastCheckedAt < BOLD_FALLBACK_COOLDOWN_MS) {
    return false;
  }
  const next = { checkedAt: new Date(now).toISOString() };
  const result = current?.data
    ? await store.setJSON(key, next, { onlyIfMatch: current.etag })
    : await store.setJSON(key, next, { onlyIfNew: true });
  // A failed or ambiguous claim must not trigger another upstream request.
  return Boolean(result?.modified && result?.etag);
}

async function reconcileBoldLink(order) {
  const paymentLink = String(order?.boldPaymentLink || "").trim();
  const apiKey = env("BOLD_API_KEY");
  if (!paymentLink || !apiKey) return order;
  try {
    if (!(await claimBoldFallbackCheck(String(order.reference || "")))) return order;
  } catch (error) {
    console.error("Bold notification fallback: no se pudo reservar consulta", String(error?.name || "Error"));
    return order;
  }

  // En API Link de Bold, metadata.reference suele ser el ID LNK_* del enlace,
  // no la referencia interna del pedido MF. Consultamos por el ID del link y
  // aceptamos únicamente la referencia del link asociado o la referencia MF.
  let response;
  try {
    response = await fetch(
      "https://integrations.api.bold.co/payments/webhook/notifications/" +
        encodeURIComponent(paymentLink),
      {
        method: "GET",
        headers: { Authorization: "x-api-key " + apiKey },
        signal: AbortSignal.timeout(10000)
      }
    );
  } catch (error) {
    console.error("Bold notification fallback: consulta fallida", String(error?.name || "Error"));
    return order;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Bold notification fallback: HTTP", response.status);
    return order;
  }

  const notifications = Array.isArray(payload?.notifications) ? payload.notifications : [];
  // Validar referencia, tipo, moneda e importe antes de considerar cualquier cambio.
  const candidates = notifications
    .filter(item =>
      [String(paymentLink), String(order.reference)].includes(
        String(item?.data?.metadata?.reference || "").trim()
      ) &&
      ["SALE_APPROVED", "SALE_REJECTED", "VOID_APPROVED", "VOID_REJECTED"].includes(
        String(item?.type || "").toUpperCase()
      )
    )
    .sort((a, b) => {
      const ta = Date.parse(String(a?.data?.created_at || ""));
      const tb = Date.parse(String(b?.data?.created_at || ""));
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
  const notification = candidates[0];
  if (!notification) return order;

  const type = String(notification.type).toUpperCase();
  const data = notification.data || {};
  const currency = String(data?.amount?.currency || "").toUpperCase();
  const amount = Math.round(Number(data?.amount?.total));
  if (
    currency !== "COP" ||
    !Number.isFinite(amount) ||
    amount !== Number(order.total)
  ) {
    console.error("Bold status fallback: importe o moneda no coinciden", {
      reference: order.reference,
      expected: order.total,
      received: data?.amount?.total,
      currency
    });
    return order;
  }

  const transactionId = String(data?.payment_id || notification.subject || paymentLink).trim();
  const event = {
    id: "poll_" + String(order.reference) + "_" + type + "_" + transactionId,
    type,
    subject: transactionId,
    source: String(notification.source || "/payments/links"),
    spec_version: "1.0",
    time: Number(notification.time) || Date.now() * 1000000,
    data: {
      ...data,
      payment_id: transactionId,
      amount: { ...data.amount, currency, total: amount },
      metadata: { ...data.metadata, reference: String(order.reference) }
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
