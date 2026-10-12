import { store, json } from "./_admin.mjs";
import { applyBoldPaymentEvent } from "./_orders.mjs";
import { enqueuePurchase } from "./_meta-outbox.mjs";
import { enqueueWhatsAppConfirmation, processWhatsAppOutboxKey } from "./_whatsapp.mjs";

const REF = /^[A-Za-z0-9_-]{1,80}$/;
const BOLD_PAYMENT_METHOD = "Link de pago (Bold)";

// La tienda abre el Embedded Checkout / Botón de pagos de Bold con
// orderId = referencia del pedido MF (ver crear-link-pago.mjs). Ese es el
// identificador de venta contra el que Bold documenta la consulta de estado.
// El enlace LNK_* que también se crea NO es el medio de pago real, por lo que
// ninguna notificación de Bold está asociada a él.
const BOLD_VOUCHER_URL = "https://payments.api.bold.co/v2/payment-voucher/";
const BOLD_NOTIFICATIONS_URL = "https://integrations.api.bold.co/payments/webhook/notifications/";
const BOLD_FALLBACK_COOLDOWN_MS = 15000;
const BOLD_REQUEST_TIMEOUT_MS = 10000;

function env(name) {
  try {
    if (typeof Netlify !== "undefined" && Netlify?.env?.get) {
      const value = Netlify.env.get(name);
      if (value) return String(value).trim();
    }
  } catch {}
  return String(process.env[name] || "").trim();
}

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

// GET autenticado a Bold. Nunca registra la clave ni el cuerpo de la respuesta
// (puede contener datos del pagador); solo la etapa y el código HTTP.
async function boldGet(url, apiKey, label) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: "x-api-key " + apiKey },
      signal: AbortSignal.timeout(BOLD_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    console.error(label + ": consulta fallida", String(error?.name || "Error"));
    return { ok: false };
  }
  if (!response.ok) {
    console.error(label + ": HTTP", response.status);
    return { ok: false, status: response.status };
  }
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    console.error(label + ": respuesta sin JSON válido");
    return { ok: false };
  }
  return { ok: true, payload };
}

function toEventTime(value) {
  const ms = Date.parse(String(value || "").trim());
  return (Number.isFinite(ms) ? ms : Date.now()) * 1000000;
}

// Fuente 1: estado de la venta del Botón de pagos, por orderId (= referencia MF).
// Devuelve { event } solo si Bold informa APPROVED y los datos cuadran con el
// pedido. { failed: true } significa "no se obtuvo una respuesta utilizable" y
// habilita la fuente 2; cualquier otra respuesta de Bold es concluyente.
async function lookupButtonVoucher(order, apiKey) {
  const reference = String(order.reference);
  const result = await boldGet(
    BOLD_VOUCHER_URL + encodeURIComponent(reference),
    apiKey,
    "Bold payment-voucher"
  );
  if (!result.ok) return { failed: true };

  const voucher = result.payload;
  const status = String(voucher.payment_status || "").toUpperCase();
  if (!status) {
    console.error("Bold payment-voucher: respuesta sin payment_status");
    return { failed: true };
  }
  if (status !== "APPROVED") return { event: null };

  const total = Number(voucher.total);
  if (!Number.isInteger(total) || total !== Number(order.total)) {
    console.error("Bold payment-voucher: importe no coincide", {
      reference,
      expected: order.total,
      received: voucher.total
    });
    return { event: null };
  }
  const voucherReference = String(voucher.reference_id ?? "").trim();
  if (voucherReference && voucherReference !== reference) {
    console.error("Bold payment-voucher: reference_id no coincide", { reference });
    return { event: null };
  }
  const transactionId = String(voucher.transaction_id || "").trim();
  if (!transactionId) {
    console.error("Bold payment-voucher: aprobado sin transaction_id", { reference });
    return { event: null };
  }

  return {
    event: {
      id: "poll_" + reference + "_SALE_APPROVED_" + transactionId,
      type: "SALE_APPROVED",
      subject: transactionId,
      source: "/payments/button",
      spec_version: "1.0",
      time: toEventTime(voucher.transaction_date),
      data: {
        payment_id: transactionId,
        created_at: String(voucher.transaction_date || ""),
        payment_method: String(voucher.payment_method || ""),
        payer_email: String(voucher.payer_email || ""),
        // El voucher no informa moneda. El checkout se crea en el servidor con
        // currency=COP y una integritySignature atada a referencia+importe+moneda
        // (crear-link-pago.mjs), y el importe se compara arriba con el pedido.
        amount: { currency: "COP", total },
        metadata: { reference }
      }
    }
  };
}

// Fuente 2 (respaldo documentado por Bold): notificaciones consultadas por
// referencia externa. Se acepta solo SALE_APPROVED con la referencia MF exacta,
// moneda COP e importe igual al del pedido.
async function lookupNotificationsByReference(order, apiKey) {
  const reference = String(order.reference);
  const result = await boldGet(
    BOLD_NOTIFICATIONS_URL + encodeURIComponent(reference) + "?is_external_reference=true",
    apiKey,
    "Bold notifications"
  );
  if (!result.ok) return { failed: true };

  const notifications = Array.isArray(result.payload.notifications) ? result.payload.notifications : [];
  const candidates = notifications
    .filter(item =>
      String(item?.type || "").toUpperCase() === "SALE_APPROVED" &&
      String(item?.data?.metadata?.reference || "").trim() === reference
    )
    .sort((a, b) => {
      const ta = Date.parse(String(a?.data?.created_at || ""));
      const tb = Date.parse(String(b?.data?.created_at || ""));
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
  const notification = candidates[0];
  if (!notification) return { event: null };

  const data = notification.data || {};
  const currency = String(data?.amount?.currency || "").toUpperCase();
  const amount = Math.round(Number(data?.amount?.total));
  if (currency !== "COP" || !Number.isFinite(amount) || amount !== Number(order.total)) {
    console.error("Bold notifications: importe o moneda no coinciden", {
      reference,
      expected: order.total,
      received: data?.amount?.total,
      currency
    });
    return { event: null };
  }
  const transactionId = String(data?.payment_id || notification.subject || "").trim();
  if (!transactionId) {
    console.error("Bold notifications: aprobado sin payment_id", { reference });
    return { event: null };
  }

  return {
    event: {
      id: "poll_" + reference + "_SALE_APPROVED_" + transactionId,
      type: "SALE_APPROVED",
      subject: transactionId,
      source: String(notification.source || "/payments"),
      spec_version: "1.0",
      time: Number(notification.time) || Date.now() * 1000000,
      data: {
        ...data,
        payment_id: transactionId,
        amount: { ...data.amount, currency, total: amount },
        metadata: { ...data.metadata, reference }
      }
    }
  };
}

// Persiste la aprobación verificada con escritura condicional y dispara los
// efectos (Meta CAPI, WhatsApp) solo si esta invocación ganó la escritura. Las
// claves de outbox son deterministas, así que el webhook y el sondeo del mismo
// pago no generan duplicados.
async function applyVerifiedApproval(order, event) {
  const key = "orders/" + order.reference;
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!current?.data) return order;
  if (current.data.paymentStatus !== "pendiente") return current.data;

  const next = applyBoldPaymentEvent(current.data, event, new Date().toISOString());
  const saved = await store.setJSON(key, next, { onlyIfMatch: current.etag });
  if (!saved?.modified) {
    return (await store.get(key, { type: "json", consistency: "strong" })) || order;
  }

  try {
    await enqueuePurchase(next);
  } catch (error) {
    console.error("No se pudo encolar Purchase desde la verificación de Bold:", error);
  }
  try {
    const outbox = await enqueueWhatsAppConfirmation(next);
    if (outbox?.key) await processWhatsAppOutboxKey(outbox.key);
  } catch (error) {
    console.error("No se pudo enviar WhatsApp desde la verificación de Bold:", error);
  }

  return next;
}

// check: "checked"  -> se consultó a Bold y respondió (aprobado o sin aprobación)
//        "recent"   -> consulta reciente reutilizada (límite de frecuencia)
//        "unavailable" -> no se pudo consultar a Bold (error HTTP, red, formato)
async function reconcileBoldPayment(order) {
  const apiKey = env("BOLD_API_KEY");
  if (!apiKey) {
    console.error("Verificación de pago Bold: falta BOLD_API_KEY");
    return { order, check: "unavailable" };
  }
  try {
    if (!(await claimBoldFallbackCheck(String(order.reference || "")))) {
      return { order, check: "recent" };
    }
  } catch (error) {
    console.error("Verificación de pago Bold: no se pudo reservar la consulta", String(error?.name || "Error"));
    return { order, check: "unavailable" };
  }

  let found = await lookupButtonVoucher(order, apiKey);
  if (found.failed) found = await lookupNotificationsByReference(order, apiKey);
  if (found.failed) return { order, check: "unavailable" };
  if (!found.event) return { order, check: "checked" };

  return { order: await applyVerifiedApproval(order, found.event), check: "checked" };
}

export default async (req) => {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);

  // Solo se usa `ref`. Los parámetros que Bold agrega al regresar (por ejemplo
  // bold-tx-status) vienen del navegador y no se consideran prueba de pago.
  const ref = String(new URL(req.url).searchParams.get("ref") || "").trim();
  if (!REF.test(ref)) return json({ error: "Referencia inválida" }, 400);

  let order = await store.get("orders/" + ref, { type: "json", consistency: "strong" });
  if (!order) return json({ error: "Pedido no encontrado" }, 404);

  let verification = "not_applicable";
  if (
    order.paymentStatus === "pendiente" &&
    (order.paymentMethod === BOLD_PAYMENT_METHOD || order.boldPaymentLink)
  ) {
    try {
      const result = await reconcileBoldPayment(order);
      order = result.order;
      verification = result.check;
    } catch (error) {
      console.error("No se pudo verificar el estado del pago en Bold:", error);
      verification = "unavailable";
    }
  }

  return json({
    reference: order.reference,
    paymentStatus: order.paymentStatus || "pendiente",
    status: order.status || "nuevo",
    total: Number(order.total) || 0,
    paymentLink: order.paymentLink || "",
    boldPaymentLink: order.boldPaymentLink || "",
    verification
  });
};
