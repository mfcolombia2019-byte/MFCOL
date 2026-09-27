import { json, requireAdmin } from "./_admin.mjs";

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  if (!process.env.BOLD_API_KEY) return json({ error: "Falta BOLD_API_KEY en Netlify" }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const total = Math.round(Number(body?.total));
  const reference = /^[A-Za-z0-9_-]{1,60}$/.test(body?.reference || "") ? body.reference : undefined;
  const description = String(body?.description || "Pedido MF Colombia").trim().slice(0, 100);

  if (!Number.isFinite(total) || total < 1000 || total > 20000000) return json({ error: "Total inválido" }, 400);
  if (description.length < 2) return json({ error: "Descripción inválida" }, 400);

  const payload = {
    amount_type: "CLOSE",
    amount: { currency: "COP", total_amount: total, tip_amount: 0 },
    description,
    expiration_date: (Date.now() * 1e6) + (24 * 60 * 60 * 1e9)
  };
  if (reference) payload.reference = reference;

  const res = await fetch("https://integrations.api.bold.co/online/link/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "x-api-key " + process.env.BOLD_API_KEY
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payload?.url) return json({ error: "Bold rechazó la creación del link", detail: data.errors || undefined }, 502);

  return json({
    ok: true,
    url: data.payload.url,
    payment_link: data.payload.payment_link,
    reference: reference || data.payload.payment_link,
    total
  });
};
