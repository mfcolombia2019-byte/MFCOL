import { json, requireAdmin } from "./_admin.mjs";

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  if (!process.env.BOLD_API_KEY) return json({ error: "Falta BOLD_API_KEY en Netlify" }, 503);

  const url = new URL(req.url);
  const paymentLink = String(url.searchParams.get("payment_link") || "").trim();
  const externalReference = String(url.searchParams.get("reference") || "").trim();

  if (!paymentLink && !externalReference) return json({ error: "Falta payment_link o reference" }, 400);

  let endpoint;
  if (paymentLink) {
    if (!/^LNK_[A-Za-z0-9_-]+$/.test(paymentLink)) return json({ error: "payment_link inválido" }, 400);
    endpoint = "https://integrations.api.bold.co/online/link/v1/" + encodeURIComponent(paymentLink);
  } else {
    endpoint = "https://integrations.api.bold.co/payments/webhook/notifications/" +
      encodeURIComponent(externalReference) + "?is_external_reference=true";
  }

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
