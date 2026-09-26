// netlify/functions/bold-webhook.mjs
// Recibe las notificaciones de pago de Bold (webhook) y, cuando una venta
// queda aprobada, guarda un registro en Netlify Forms para que llegue un
// correo automático (configurando la notificación de ese formulario en
// Netlify: Forms → pagos-confirmados → Settings → Form notifications).
//
// Requiere la variable de entorno BOLD_SECRET_KEY (llave secreta de Bold),
// configurada en Netlify: Site configuration → Environment variables.
//
// Configura esta URL como webhook en panel.bold.co → Integraciones → Webhooks:
//   https://TU-SITIO.netlify.app/.netlify/functions/bold-webhook

import crypto from "node:crypto";

function encodeForm(data) {
  return Object.keys(data)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(data[k] ?? ""))
    .join("&");
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Método no permitido", { status: 405 });

  const rawBody = await req.text();
  const signature = req.headers.get("x-bold-signature") || "";
  const secret = process.env.BOLD_SECRET_KEY || "";

  const encoded = Buffer.from(rawBody, "utf-8").toString("base64");
  const hashed = crypto.createHmac("sha256", secret).update(encoded).digest("hex");

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(hashed), Buffer.from(signature));
  } catch {
    valid = false;
  }

  if (!valid) {
    console.error("Firma de webhook inválida");
    return new Response("Firma inválida", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("JSON inválido", { status: 400 });
  }

  // Responde rápido; Bold espera un 200 en menos de 2 segundos.
  if (event.type === "SALE_APPROVED") {
    const d = event.data || {};
    const reference = d.metadata?.reference || "";
    const total = d.amount?.total;
    const paymentMethod = d.payment_method || "";
    const paymentId = d.payment_id || event.subject || "";

    try {
      const siteUrl = new URL(req.url).origin;
      await fetch(siteUrl + "/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm({
          "form-name": "pagos-confirmados",
          reference,
          payment_id: paymentId,
          valor: total != null ? String(total) : "",
          medio_pago: paymentMethod,
          estado: "Aprobado",
        }),
      });
    } catch (e) {
      console.error("No se pudo registrar la confirmación:", e);
    }
  }

  return new Response("OK", { status: 200 });
};
