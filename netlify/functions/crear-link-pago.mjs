// API Link de pagos de Bold.
// La API key nunca llega al navegador: vive en BOLD_API_KEY de Netlify.

const json = (data, status = 200) => Response.json(data, {
  status,
  headers: { "Cache-Control": "no-store" }
});

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "JSON inválido" }, 400); }

  const total = Math.round(Number(body?.total));
  const descripcion = String(body?.descripcion || "Pedido MF Colombia").trim().slice(0, 100);
  const reference = /^[A-Za-z0-9_-]{1,60}$/.test(body?.reference || "") ? body.reference : undefined;
  const callbackUrl = /^https:\/\//.test(body?.callback_url || "") ? body.callback_url : undefined;
  const payerEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body?.payer_email || "") ? body.payer_email : undefined;

  if (!Number.isFinite(total) || total < 1000 || total > 20000000) {
    return json({ error: "Total inválido" }, 400);
  }
  if (descripcion.length < 2) return json({ error: "Descripción inválida" }, 400);
  if (!process.env.BOLD_API_KEY) {
    return json({ error: "Falta configurar BOLD_API_KEY en Netlify" }, 500);
  }

  const payload = {
    amount_type: "CLOSE",
    amount: { currency: "COP", total_amount: total, tip_amount: 0 },
    description: descripcion,
    expiration_date: (Date.now() * 1e6) + (24 * 60 * 60 * 1e9)
  };
  if (reference) payload.reference = reference;
  if (callbackUrl) payload.callback_url = callbackUrl;
  if (payerEmail) payload.payer_email = payerEmail;

  const res = await fetch("https://integrations.api.bold.co/online/link/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "x-api-key " + process.env.BOLD_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payload?.url) {
    console.error("Bold create link:", res.status, JSON.stringify(data));
    return json({ error: "No se pudo crear el link de pago", detail: data.errors || undefined }, 502);
  }

  return json({
    url: data.payload.url,
    payment_link: data.payload.payment_link,
    referencia: data.payload.payment_link,
    reference: reference || data.payload.payment_link,
    total
  });
};
