import crypto from "node:crypto";

export const META_DATASET_ID = "1092821839891082";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
}

function normalizePhone(value) {
  return String(value || "").replace(/\\D/g, "");
}

function splitName(value) {
  const parts = normalizeName(value).split(/\\s+/).filter(Boolean);
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

export async function sendMetaEvent(event) {
  const token = String(process.env.META_CAPI_ACCESS_TOKEN || "");
  let version = String(process.env.META_GRAPH_API_VERSION || "").trim();
  const datasetId = String(process.env.META_DATASET_ID || META_DATASET_ID);
  if (!token) { const error = new Error("Falta META_CAPI_ACCESS_TOKEN"); error.retryable = false; throw error; }
  if (!/^v?\\d+\\.\\d+$/.test(version)) { const error = new Error("META_GRAPH_API_VERSION inválida"); error.retryable = false; throw error; }
  if (!version.startsWith("v")) version = "v" + version;
  if (!/^\\d+$/.test(datasetId)) { const error = new Error("META_DATASET_ID inválido"); error.retryable = false; throw error; }

  const payload = { data: [event] };
  if (process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = String(process.env.META_TEST_EVENT_CODE);
  }

  const endpoint = "https://graph.facebook.com/" + encodeURIComponent(version) +
    "/" + encodeURIComponent(datasetId) + "/events?access_token=" + encodeURIComponent(token);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("Meta CAPI rechazó Purchase (" + response.status + ")");
    error.metaStatus = response.status;
    error.metaResponse = data;
    throw error;
  }

  return { status: response.status, response: data };
}

export async function sendMetaPurchase(order) {
  return sendMetaEvent(buildMetaPurchase(order));
}
