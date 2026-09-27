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

  const res = await fetch(endpoint, {
    headers: { "Authorization": "x-api-key " + process.env.BOLD_API_KEY }
  });
  const data = await res.json().catch(() => ({}));
  return json(data, res.ok ? 200 : 502);
};
