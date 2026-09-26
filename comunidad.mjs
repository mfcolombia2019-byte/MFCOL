// netlify/functions/comunidad.mjs
// API de "Comunidad Marlon": reseñas, fotos, moderación y enlaces de compra verificada.
// Almacenamiento: Netlify Blobs (incluido en Netlify, sin base de datos externa).
// Requiere la variable de entorno ADMIN_KEY (tu clave para moderar en /moderar.html).

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const json = (d, s = 200, h = {}) => Response.json(d, { status: s, headers: h });
const clean = (v, n) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, n);
const ID = /^[a-z0-9-]{1,60}$/;
const TK = /^[a-f0-9]{24}$/;

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";
  const admin = !!process.env.ADMIN_KEY && req.headers.get("x-admin-key") === process.env.ADMIN_KEY;
  const posts = getStore("comunidad-posts");
  const photos = getStore("comunidad-fotos");
  const tokens = getStore("comunidad-tokens");

  /* ---------- Lectura ---------- */
  if (req.method === "GET") {
    if (action === "public" || (action === "all" && admin)) {
      const { blobs } = await posts.list();
      let all = (await Promise.all(blobs.map((b) => posts.get(b.key, { type: "json" })))).filter(Boolean);
      if (action === "public") {
        all = all.filter((p) => p.status === "approved").map((p) => ({
          id: p.id, product: p.product, productName: p.productName, rating: p.rating, text: p.text,
          instagram: p.instagram, verified: p.verified, featured: p.featured, hasPhoto: p.hasPhoto, created: p.created,
        }));
      }
      all.sort((a, b) => b.created - a.created);
      return json(all, 200, { "Cache-Control": action === "public" ? "public, max-age=60" : "no-store" });
    }
    if (action === "photo") {
      const id = url.searchParams.get("id") || "";
      if (!TK.test(id)) return new Response("No encontrado", { status: 404 });
      const post = await posts.get(id, { type: "json" });
      if (!post || (post.status !== "approved" && !admin)) return new Response("No encontrado", { status: 404 });
      const buf = await photos.get(id, { type: "arrayBuffer" });
      if (!buf) return new Response("No encontrado", { status: 404 });
      return new Response(buf, { headers: {
        "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff",
        "Cache-Control": post.status === "approved" ? "public, max-age=86400" : "no-store",
      } });
    }
    if (action === "token") {
      const t = url.searchParams.get("t") || "";
      const tk = TK.test(t) ? await tokens.get(t, { type: "json" }) : null;
      const left = tk ? tk.products.filter((p) => !(tk.done || []).includes(p.id)) : [];
      if (!left.length) return json({ error: "Este enlace no es válido o ya fue utilizado." }, 404);
      return json({ products: left });
    }
    return json({ error: "Acción inválida" }, 400);
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  /* ---------- Acciones de administración ---------- */
  if (action === "moderate" || action === "issue-token") {
    if (!admin) return json({ error: "No autorizado" }, 401);
    const b = await req.json().catch(() => ({}));

    if (action === "moderate") {
      const id = String(b.id || "");
      const post = TK.test(id) ? await posts.get(id, { type: "json" }) : null;
      if (!post) return json({ error: "No encontrado" }, 404);
      if (b.op === "delete") { await posts.delete(id); await photos.delete(id); return json({ ok: true }); }
      if (b.op === "approve") post.status = "approved";
      else if (b.op === "reject") { post.status = "rejected"; post.featured = false; }
      else if (b.op === "feature") post.featured = !post.featured;
      else return json({ error: "Operación inválida" }, 400);
      await posts.setJSON(id, post);
      return json({ ok: true });
    }

    // Enlace de compra verificada: se lo envías a la clienta (WhatsApp o correo).
    const products = (Array.isArray(b.products) ? b.products : []).slice(0, 10)
      .map((p) => ({ id: String(p.id || ""), name: clean(p.name, 80) })).filter((p) => ID.test(p.id) && p.name);
    if (!products.length) return json({ error: "Falta el producto" }, 400);
    const t = crypto.randomBytes(12).toString("hex");
    await tokens.setJSON(t, { products, ref: clean(b.ref, 60), done: [], created: Date.now() });
    return json({ token: t, url: url.origin + "/comunidad.html?t=" + t });
  }

  /* ---------- Envío de una clienta ---------- */
  let f;
  try { f = await req.formData(); } catch { return json({ error: "Formulario inválido" }, 400); }
  if (f.get("empresa")) return json({ ok: true }); // trampa anti-spam

  const product = clean(f.get("product"), 60);
  const productName = clean(f.get("productName"), 80);
  const rating = Math.round(Number(f.get("rating")));
  const text = clean(f.get("text"), 500);
  const ig = clean(f.get("instagram"), 40).replace(/^@/, "");
  const file = f.get("photo");
  const hasPhoto = !!file && typeof file === "object" && file.size > 0;

  if (!ID.test(product) || !productName) return json({ error: "Producto no válido" }, 400);
  if (!(rating >= 1 && rating <= 5)) return json({ error: "Elige tu calificación" }, 400);
  if (ig && !/^[A-Za-z0-9._]{1,30}$/.test(ig)) return json({ error: "Usuario de Instagram no válido" }, 400);
  if (!hasPhoto && !text) return json({ error: "Escribe una reseña o sube una fotografía" }, 400);

  let buf = null;
  if (hasPhoto) {
    if (f.get("consent") !== "1") return json({ error: "Necesitamos tu autorización para usar la fotografía" }, 400);
    if (file.size > 3 * 1024 * 1024) return json({ error: "La fotografía es demasiado pesada" }, 400);
    buf = await file.arrayBuffer();
    const h = new Uint8Array(buf);
    if (h[0] !== 0xff || h[1] !== 0xd8) return json({ error: "Sube una fotografía JPG, PNG o WEBP" }, 400);
  }

  // Compra verificada: solo si trae un enlace emitido por ti, sin usar para ese modelo.
  let verified = false;
  const t = clean(f.get("token"), 40);
  if (t) {
    const tk = TK.test(t) ? await tokens.get(t, { type: "json" }) : null;
    tk && (tk.done = tk.done || []);
    if (!tk || !tk.products.some((p) => p.id === product) || tk.done.includes(product)) {
      return json({ error: "Este enlace no es válido para este modelo o ya fue utilizado." }, 400);
    }
    tk.done.push(product);
    await tokens.setJSON(t, tk);
    verified = true;
  }

  const id = crypto.randomBytes(12).toString("hex");
  if (buf) await photos.set(id, buf);
  await posts.setJSON(id, {
    id, product, productName, rating, text, instagram: ig, verified, featured: false,
    hasPhoto, consent: hasPhoto, status: "pending", created: Date.now(),
  });
  return json({ ok: true });
};
