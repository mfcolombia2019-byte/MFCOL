import { json, sessionCookie, clearCookie } from "./_admin.mjs";

export default async (req) => {
  if (req.method === "GET") {
    const { isAdmin } = await import("./_admin.mjs");
    return isAdmin(req) ? json({ ok: true }) : json({ ok: false }, 401);
  }
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body = {};
  try { body = await req.json(); } catch {}

  if (body.action === "logout") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": clearCookie() }
    });
  }

  if (body.action !== "login") return json({ error: "Acción inválida" }, 400);
  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_SESSION_SECRET) {
    return json({ error: "Configura ADMIN_PASSWORD y ADMIN_SESSION_SECRET en Netlify." }, 503);
  }
  const password = String(body.password || "");
  const expected = String(process.env.ADMIN_PASSWORD);
  const a = Buffer.from(password), b = Buffer.from(expected);
  let valid = a.length === b.length;
  if (valid) {
    const crypto = await import("node:crypto");
    valid = crypto.timingSafeEqual(a, b);
  }
  if (!valid) return json({ error: "Contraseña incorrecta" }, 401);

  const crypto = await import("node:crypto");
  const value = crypto.randomBytes(32).toString("hex") + "." + Date.now();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": sessionCookie(value)
    }
  });
};
