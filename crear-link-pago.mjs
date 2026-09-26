// netlify/functions/crear-link-pago.mjs
// Crea un link de pago en Bold para el pedido del checkout de MF Colombia.
// Requiere la variable de entorno BOLD_API_KEY (llave de identidad de Bold),
// configurada en Netlify: Site configuration → Environment variables.

const json = (data, status = 200) => Response.json(data, { status });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const total = Math.round(Number(body?.total));
  const descripcion = String(body?.descripcion || "Pedido MF Colombia").slice(0, 100);
  const reference = /^[A-Za-z0-9_-]{1,60}$/.test(body?.reference || "") ? body.reference : undefined;
  const callbackUrl = /^https:\/\//.test(body?.callback_url || "") ? body.callback_url : undefined;

  if (!Number.isFinite(total) || total < 1000 || total > 20000000) {
    return json({ error: "Total inválido" }, 400);
  }

  if (!process.env.BOLD_API_KEY) {
    return json({ error: "Falta configurar BOLD_API_KEY en Netlify" }, 500);
  }

  const payload = {
    amount_type: "CLOSE",
    amount: { currency: "COP", total_amount: total, tip_amount: 0 },
    description: descripcion,
    expiration_date: (Date.now() + 24 * 60 * 60 * 1000) * 1e6, // 24 h, en nanosegundos
  };
  if (reference) payload.reference = reference;
  if (callbackUrl) payload.callback_url = callbackUrl;

  const res = await fetch("https://integrations.api.bold.co/online/link/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `x-api-key ${process.env.BOLD_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.payload?.url) {
    console.error("Error Bold:", res.status, JSON.stringify(data));
    return json({ error: "No se pudo crear el link de pago" }, 502);
  }

  return json({ url: data.payload.url, referencia: data.payload.payment_link, total });
};
