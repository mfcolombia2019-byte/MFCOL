import { json, requireAdmin } from "./_admin.mjs";

const REF = /^[A-Za-z0-9_-]{1,80}$/;
// Mismo origen de verdad que order-status.mjs: el Botón de pagos se consulta por
// orderId (= referencia MF). Las notificaciones por referencia externa son solo respaldo.
const BOLD_VOUCHER_URL = "https://payments.api.bold.co/v2/payment-voucher/";
const BOLD_NOTIFICATIONS_URL = "https://integrations.api.bold.co/payments/webhook/notifications/";
// Dos consultas secuenciales deben caber en el límite de 10 s de una función de Netlify.
const BOLD_TIMEOUT_MS = 4500;

const VOUCHER_REJECTED = new Set(["REJECTED", "FAILED", "DECLINED", "CANCELLED", "CANCELED", "EXPIRED"]);
const VOUCHER_VOIDED = new Set(["VOIDED"]);
const VOUCHER_PENDING = new Set(["PENDING", "PROCESSING", "IN_PROCESS", "CREATED"]);

// GET autenticado a Bold. Nunca devuelve ni registra el cuerpo de la respuesta de
// error (puede contener datos del pagador): solo etapa, código HTTP y formato.
async function boldGet(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "Authorization": "x-api-key " + process.env.BOLD_API_KEY },
      signal: AbortSignal.timeout(BOLD_TIMEOUT_MS)
    });
  } catch (error) {
    return { failure: { kind: "network", timeout: error?.name === "TimeoutError" } };
  }
  const contentType = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  let text = "";
  try {
    text = await res.text();
  } catch (error) {
    // El timeout también cubre la lectura del cuerpo: se informa como tal.
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return { failure: { kind: "network", timeout: true } };
    }
  }
  let data = null;
  try {
    if (text) data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const providerCode = data && typeof data === "object"
      ? String(data.code || data.error_code || "").slice(0, 80)
      : "";
    return { failure: { kind: "http", httpStatus: res.status, contentType, responseFormat: data === null ? "non_json_or_empty" : "json", providerCode } };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { failure: { kind: "format", httpStatus: res.status, contentType } };
  }
  return { data };
}

function failureResponse(failure, fallbackFailure) {
  const diagnostic = { stage: "bold_api_response", contentType: failure.contentType || "unknown" };
  if (failure.kind === "network") {
    const timeout = Boolean(failure.timeout);
    return json({
      error: timeout ? "Bold tardó demasiado en responder" : "No fue posible conectar con Bold",
      code: "bold_unavailable",
      diagnostic: { stage: timeout ? "upstream_timeout" : "upstream_fetch_failed" }
    }, 502);
  }
  diagnostic.httpStatus = failure.httpStatus;
  diagnostic.responseFormat = failure.kind === "format" ? "non_json_or_empty" : failure.responseFormat;
  if (failure.providerCode) diagnostic.providerCode = failure.providerCode;
  if (fallbackFailure?.httpStatus) diagnostic.fallbackHttpStatus = fallbackFailure.httpStatus;

  if (failure.kind === "format") {
    return json({ error: "Bold devolvió una respuesta inesperada o que no es JSON", code: "bold_bad_response", diagnostic }, 502);
  }
  const status = failure.httpStatus;
  if (status === 401 || status === 403) {
    return json({ error: "Bold rechazó las credenciales o la configuración de la integración", code: "bold_auth", diagnostic }, 502);
  }
  if (status === 404) {
    return json({ error: "Referencia inexistente en Bold", code: "bold_not_found", diagnostic }, 404);
  }
  if (status === 429 || status >= 500) {
    return json({ error: "Bold no está disponible temporalmente. Intenta de nuevo en unos minutos", code: "bold_unavailable", diagnostic }, 502);
  }
  return json({ error: "Bold rechazó la consulta", code: "bold_rejected", diagnostic }, 502);
}

function mismatchResponse(source, why) {
  return json({
    error: "La respuesta de Bold no corresponde a esta referencia; no se confirma el pago",
    code: "bold_reference_mismatch",
    diagnostic: { stage: "reference_verification", source, reason: why }
  }, 502);
}

function paymentBody(base, paymentStatus, message, verified) {
  return { ok: true, ...base, paymentStatus, message, verified };
}

// Interpreta payment-voucher. Una aprobación solo se informa si reference_id es
// exactamente la referencia consultada y existe transaction_id; nunca por parámetros del navegador.
function interpretVoucher(voucher, reference) {
  const status = String(voucher.payment_status || "").toUpperCase();
  // Sin estado la respuesta no es utilizable: se prueba el respaldo, como en order-status.
  if (!status) return { unusable: true };

  const voucherReference = String(voucher.reference_id ?? "").trim();
  if (voucherReference && voucherReference !== reference) {
    return { response: mismatchResponse("payment-voucher", "reference_id_differs") };
  }
  const base = { source: "payment-voucher", reference };
  const total = Number(voucher.total);
  if (Number.isFinite(total)) base.total = total;
  if (voucher.payment_method) base.paymentMethod = String(voucher.payment_method).slice(0, 40);

  if (status === "APPROVED") {
    const transactionId = String(voucher.transaction_id || "").trim();
    if (!voucherReference) return { response: mismatchResponse("payment-voucher", "approved_without_reference_id") };
    if (!transactionId) return { response: mismatchResponse("payment-voucher", "approved_without_transaction_id") };
    return { body: paymentBody({ ...base, transactionId }, "aprobado", "Pago aprobado", true) };
  }
  if (VOUCHER_REJECTED.has(status)) {
    return { body: paymentBody(base, "rechazado", "Pago rechazado", Boolean(voucherReference)) };
  }
  if (VOUCHER_VOIDED.has(status)) {
    return { body: paymentBody(base, "anulado", "Pago anulado", Boolean(voucherReference)) };
  }
  if (VOUCHER_PENDING.has(status)) {
    return { body: paymentBody(base, "pendiente", "Pago pendiente de confirmación en Bold", Boolean(voucherReference)) };
  }
  return { body: paymentBody(base, "desconocido", "Bold informó un estado que esta consulta no reconoce", false) };
}

// Interpreta el respaldo de notificaciones: solo eventos con metadata.reference exacta.
function interpretNotifications(data, reference) {
  const events = (Array.isArray(data.notifications) ? data.notifications : [])
    .filter(item =>
      ["SALE_APPROVED", "SALE_REJECTED", "VOID_APPROVED"].includes(String(item?.type || "").toUpperCase()) &&
      String(item?.data?.metadata?.reference || "").trim() === reference
    )
    .sort((a, b) => {
      const ta = Date.parse(String(a?.data?.created_at || ""));
      const tb = Date.parse(String(b?.data?.created_at || ""));
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
  const latest = events[0];
  if (!latest) return { none: true };

  const type = String(latest.type).toUpperCase();
  const base = { source: "notifications", reference };
  const amount = Number(latest.data?.amount?.total);
  if (Number.isFinite(amount)) base.total = amount;
  if (latest.data?.payment_method) base.paymentMethod = String(latest.data.payment_method).slice(0, 40);

  if (type === "SALE_APPROVED") {
    const transactionId = String(latest.data?.payment_id || latest.subject || "").trim();
    const currency = String(latest.data?.amount?.currency || "").toUpperCase();
    if (!transactionId || currency !== "COP") {
      return { response: mismatchResponse("notifications", "approved_without_payment_id_or_currency") };
    }
    return { body: paymentBody({ ...base, transactionId }, "aprobado", "Pago aprobado", true) };
  }
  if (type === "VOID_APPROVED") return { body: paymentBody(base, "anulado", "Pago anulado", true) };
  return { body: paymentBody(base, "rechazado", "Pago rechazado", true) };
}

async function queryByReference(reference) {
  let voucher = await boldGet(BOLD_VOUCHER_URL + encodeURIComponent(reference));
  if (voucher.data) {
    const result = interpretVoucher(voucher.data, reference);
    if (!result.unusable) return result.response || json(result.body, 200);
    voucher = { failure: { kind: "format", httpStatus: 200, contentType: "unknown" } };
  }

  const notifications = await boldGet(BOLD_NOTIFICATIONS_URL + encodeURIComponent(reference) + "?is_external_reference=true");
  if (notifications.failure) return failureResponse(voucher.failure, notifications.failure);

  const result = interpretNotifications(notifications.data, reference);
  if (result.response) return result.response;
  if (result.body) return json(result.body, 200);
  // Sin eventos para esta referencia: si el voucher dijo "no existe", es inexistente.
  if (voucher.failure.kind === "http" && voucher.failure.httpStatus === 404) return failureResponse(voucher.failure);
  return json(paymentBody({ source: "notifications", reference }, "sin_confirmacion",
    "Bold no tiene una confirmación de pago para esta referencia (puede estar pendiente o no existir)", false), 200);
}

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  if (!process.env.BOLD_API_KEY) return json({ error: "Falta BOLD_API_KEY en Netlify" }, 503);

  const url = new URL(req.url);
  const paymentLink = String(url.searchParams.get("payment_link") || "").trim();
  const externalReference = String(url.searchParams.get("reference") || "").trim();

  if (!paymentLink && !externalReference) return json({ error: "Falta payment_link o reference" }, 400);

  if (!paymentLink) {
    if (!REF.test(externalReference)) return json({ error: "Referencia inválida" }, 400);
    return await queryByReference(externalReference);
  }
  if (!/^LNK_[A-Za-z0-9_-]+$/.test(paymentLink)) return json({ error: "payment_link inválido" }, 400);
  const endpoint = "https://integrations.api.bold.co/online/link/v1/" + encodeURIComponent(paymentLink);

  let res;
  try {
    res = await fetch(endpoint, {
      headers: { "Authorization": "x-api-key " + process.env.BOLD_API_KEY }
    });
  } catch {
    return json({ error: "No fue posible conectar con Bold", diagnostic: { stage: "upstream_fetch_failed" } }, 502);
  }

  const contentType = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const bodyText = await res.text().catch(() => "");
  let data = null;
  if (bodyText) {
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    // Do not echo Bold's raw body: it could contain sensitive payment/customer data.
    const providerCode = data && typeof data === "object"
      ? String(data.code || data.error_code || "").slice(0, 80)
      : "";
    return json({
      error: "Bold rechazó la consulta",
      diagnostic: {
        stage: "bold_api_response",
        httpStatus: res.status,
        contentType: contentType || "unknown",
        responseFormat: data === null ? "non_json_or_empty" : "json",
        providerCode: providerCode || undefined
      }
    }, 502);
  }

  if (data === null) {
    return json({
      error: "Bold devolvió una respuesta que no es JSON",
      diagnostic: {
        stage: "bold_api_response",
        httpStatus: res.status,
        contentType: contentType || "unknown",
        responseFormat: "non_json_or_empty"
      }
    }, 502);
  }

  return json(data, 200);
};
