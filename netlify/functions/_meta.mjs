import crypto from "node:crypto";

export const META_DATASET_ID = "1092821839891082";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function splitName(value) {
  const parts = normalizeName(value).split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") };
}

export function buildMetaPurchase(order) {
  const value = Number(order?.confirmedAmount);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("No existe un importe confirmado por Bold");
  }
  if (order?.paymentStatus !== "aprobado" || order?.webhookType !== "SALE_APPROVED") {
    throw new Error("Purchase solo puede generarse después de SALE_APPROVED");
  }

  const eventId = String(order?.purchaseEventId || "");
  if (!eventId) throw new Error("Falta event_id estable para Purchase");

  const { first, last } = splitName(order?.name);
  const phone = normalizePhone(order?.phone);
  const userData = {};
  if (first) userData.fn = [sha256(first)];
  if (last) userData.ln = [sha256(last)];
  if (phone) userData.ph = [sha256(phone)];
  if (order?.fbp) userData.fbp = String(order.fbp);
  if (order?.fbc) userData.fbc = String(order.fbc);
  if (order?.clientUserAgent) userData.client_user_agent = String(order.clientUserAgent).slice(0, 1000);

  return {
    event_name: "Purchase",
    event_time: Number(order.paymentEventTime) || Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: "website",
    event_source_url: String(order.eventSourceUrl || "").slice(0, 1000) || undefined,
    user_data: userData,
    custom_data: {
      currency: String(order.confirmedCurrency || "COP").toUpperCase(),
      value,
      order_id: String(order.reference || ""),
      content_type: "product",
      content_ids: Array.isArray(order.items)
        ? order.items.map(item => String(item?.id || "")).filter(Boolean)
        : [],
      contents: Array.isArray(order.items)
        ? order.items.map(item => ({
            id: String(item?.id || ""),
            quantity: Math.max(1, Number(item?.qty) || 1),
            item_price: Number(item?.unitPrice) || undefined
          })).filter(item => item.id)
        : []
    }
  };
}

// Resume el error de Graph API sin incluir el token ni datos personales.
export function summarizeMetaError(data) {
  const e = data?.error;
  if (!e || typeof e !== "object") return null;
  return {
    message: String(e.message || "").slice(0, 300),
    type: String(e.type || "").slice(0, 60),
    code: Number.isFinite(Number(e.code)) ? Number(e.code) : null,
    subcode: Number.isFinite(Number(e.error_subcode)) ? Number(e.error_subcode) : null,
    transient: e.is_transient === true,
    fbtraceId: String(e.fbtrace_id || "").slice(0, 60)
  };
}

function redactToken(text, ...tokens) {
  let out = String(text || "");
  for (const token of tokens) {
    if (token) out = out.split(token).join("[token]");
  }
  return out.replace(/access_token=[^&\s"']+/gi, "access_token=[token]");
}

// Las variables de entorno suelen guardarse con un salto de línea final, espacios o
// comillas. Meta recibe eso tal cual en la URL y responde 400/190, así que se normaliza.
export function normalizeMetaToken(raw) {
  let token = String(raw ?? "").trim();
  const quoted = token.match(/^(["'`])([\s\S]*)\1$/);
  if (quoted) token = quoted[2].trim();
  return token;
}

// Los tokens de Graph API solo usan letras, dígitos y _ - | . (el "|" aparece en tokens de app).
// Espacios, llaves, comillas o un prefijo "Bearer " indican un valor mal copiado.
const TOKEN_FORMAT = /^[A-Za-z0-9_|.-]+$/;
const TEST_EVENT_CODE_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;

function configError(message) {
  const error = new Error(message);
  error.retryable = false;
  error.errorClass = "config";
  return error;
}

export async function sendMetaEvent(event) {
  const rawToken = String(process.env.META_CAPI_ACCESS_TOKEN || "");
  const token = normalizeMetaToken(rawToken);
  let version = String(process.env.META_GRAPH_API_VERSION || "").trim();
  const datasetId = String(process.env.META_DATASET_ID || "").trim() || META_DATASET_ID;
  if (!token) throw configError("Falta META_CAPI_ACCESS_TOKEN");
  if (!TOKEN_FORMAT.test(token)) {
    // Nunca se incluye el valor: solo se describe el problema.
    throw configError("META_CAPI_ACCESS_TOKEN con formato inválido (espacios internos, comillas, llaves o prefijo; debe ser solo el token)");
  }
  if (!/^v?\d+\.\d+$/.test(version)) throw configError("META_GRAPH_API_VERSION inválida");
  if (!version.startsWith("v")) version = "v" + version;
  if (!/^\d+$/.test(datasetId)) throw configError("META_DATASET_ID inválido");

  // Mismo criterio que _admin.mjs y bold-webhook.mjs: lo que no es "production" es no productivo.
  // CONTEXT ausente (pruebas locales) conserva el comportamiento anterior.
  const context = String(process.env.CONTEXT || "").trim().toLowerCase();
  const testEventCode = String(process.env.META_TEST_EVENT_CODE || "").trim();
  if (testEventCode && !TEST_EVENT_CODE_FORMAT.test(testEventCode)) {
    // Nunca se repite el valor en el mensaje.
    throw configError("META_TEST_EVENT_CODE con formato inválido (solo letras, dígitos, _ y -)");
  }
  // Un despliegue no productivo comparte conjunto de datos y token con producción. Sin
  // test_event_code, Meta aceptaría el evento (HTTP 200, events_received: 1) como conversión
  // REAL y además no aparecería en "Probar eventos". Se conserva en el outbox y se reenvía
  // solo cuando la variable llegue al despliegue (error "config" recuperable).
  if (context && context !== "production" && !testEventCode) {
    throw configError("META_TEST_EVENT_CODE ausente en un despliegue no productivo; Purchase no se envía a Meta para no registrarlo como evento real");
  }

  const payload = { data: [event] };
  // test_event_code va en el nivel superior del cuerpo, nunca dentro del evento.
  if (testEventCode) payload.test_event_code = testEventCode;

  const endpoint = "https://graph.facebook.com/" + encodeURIComponent(version) +
    "/" + encodeURIComponent(datasetId) + "/events?access_token=" + encodeURIComponent(token);

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
  } catch (cause) {
    // Fallo de red/timeout: reintentable. Nunca se propaga la URL (lleva el token).
    const error = new Error("Meta CAPI no respondió: " + redactToken(cause?.name || "network_error", token, rawToken));
    error.retryable = true;
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const meta = summarizeMetaError(data);
    const detail = meta
      ? " code=" + meta.code + (meta.subcode ? "/" + meta.subcode : "") + " fbtrace_id=" + meta.fbtraceId + ": " + redactToken(meta.message, token, rawToken)
      : "";
    const error = new Error("Meta CAPI rechazó Purchase (" + response.status + ")" + detail);
    error.metaStatus = response.status;
    // El mensaje de Meta puede repetir fragmentos del token recibido: se limpia también el resumen guardado.
    error.metaError = meta ? { ...meta, message: redactToken(meta.message, token, rawToken) } : meta;
    error.retryable = response.status === 429 || response.status >= 500 || meta?.transient === true;
    // 190/102: token inválido, expirado o mal copiado. No es un fallo del evento: se corrige
    // la configuración y el mismo evento se reenvía (misma event_id, Meta deduplica).
    if (!error.retryable && (meta?.code === 190 || meta?.code === 102)) error.errorClass = "auth";
    throw error;
  }

  // Un 2xx sin events_received >= 1 no es una aceptación: no se debe marcar como enviado.
  const received = Number(data?.events_received);
  if (!Number.isFinite(received) || received < 1) {
    const error = new Error("Meta CAPI respondió " + response.status + " sin confirmar events_received >= 1");
    error.metaStatus = response.status;
    error.retryable = false;
    throw error;
  }

  return {
    status: response.status,
    response: data,
    eventsReceived: received,
    fbtraceId: String(data?.fbtrace_id || "").slice(0, 60),
    // true = el evento viajó con test_event_code (solo visible en "Probar eventos").
    testMode: Boolean(testEventCode)
  };
}

export async function sendMetaPurchase(order) {
  return sendMetaEvent(buildMetaPurchase(order));
}
