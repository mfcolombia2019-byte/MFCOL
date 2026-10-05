import { createHmac, timingSafeEqual } from "node:crypto";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function verifySignature(rawBody, signature, appSecret) {
  if (!signature || !appSecret || !signature.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  const received = signature.slice("sha256=".length);
  if (received.length !== expected.length) return false;

  return timingSafeEqual(
    Buffer.from(received, "utf8"),
    Buffer.from(expected, "utf8")
  );
}

export default async (req) => {
  const verifyToken = Netlify.env.get("WHATSAPP_VERIFY_TOKEN");

  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (!mode && !token && !challenge) {
      return json({ ok: true, service: "marlon-footwear-whatsapp-webhook" });
    }

    if (mode === "subscribe" && token === verifyToken && challenge) {
      return new Response(challenge, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Forbidden", { status: 403 });
  }

  if (req.method === "POST") {
    const rawBody = await req.text();
    const appSecret = Netlify.env.get("META_APP_SECRET");
    const signature = req.headers.get("x-hub-signature-256");

    if (!verifySignature(rawBody, signature, appSecret)) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    console.log("WhatsApp webhook received", JSON.stringify(payload));

    return json({ received: true });
  }

  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: "GET, POST" },
  });
};

export const config = {
  path: "/api/whatsapp-webhook",
};
