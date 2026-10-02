// netlify/functions/comunidad.mjs
// API de "Comunidad Marlon": reseñas, fotos, moderación y enlaces de compra verificada.
// Almacenamiento: Netlify Blobs.
// Usa la misma clave de administración configurada en Netlify (ADMIN_PASSWORD).

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { isAdmin } from "./_admin.mjs";

const json = (d, s = 200, h = {}) => Response.json(d, { status: s, headers: h });
const clean = (v, n) => String(v ?? "").replace(/[<>]/g, "").trim().slice(0, n);
const ID = /^[a-z0-9-]{1,60}$/;
const TK = /^[a-f0-9]{24}$/;

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";
  const admin = isAdmin(req);
  const posts = getStore("comunidad-posts");
  const photos = getStore("comunidad-fotos");
  const tokens = getStore("comunidad-tokens");
  const orders = getStore("mfc-admin");

  if (req.method === "GET") {
    if (action === "public" || action === "product" || action === "look" || (action === "all" && admin)) {
      const { blobs } = await posts.list();
      let all = (await Promise.all(blobs.map((b) => posts.get(b.key, { type: "json" })))).filter(Boolean);

      if (action === "public") {
        all = all.filter((p) => p.status === "approved").map((p) => ({
          id: p.id, product: p.product, productName: p.productName, rating: p.rating, text: p.text,
          instagram: p.instagram, verified: p.verified, featured: p.featured, hasPhoto: p.hasPhoto,
          created: p.created, customerName: p.customerName || "", kind: p.kind || "review", lookId: p.lookId || p.product,
        }));
      } else if (action === "product" || action === "look") {
        const product = clean(url.searchParams.get("product") || url.searchParams.get("look") || "", 60);
        if (!ID.test(product)) return json({ error: "Producto o Look no válido" }, 400);
        all = all.filter((p) => p.status === "approved" && p.product === product).map((p) => ({
          id: p.id, product: p.product, productName: p.productName, rating: p.rating, text: p.text,
          instagram: p.instagram, verified: p.verified, featured: p.featured, hasPhoto: p.hasPhoto,
          created: p.created, customerName: p.customerName || "", kind: p.kind || "review", lookId: p.lookId || p.product,
        }));
      }

      all.sort((a, b) => b.created - a.created);
      return json(all, 200, {
        "Cache-Control": action === "all" ? "no-store" : "public, max-age=60"
      });
    }

    if (action === "photo") {
      const id = url.searchParams.get("id") || "";
      if (!TK.test(id)) return new Response("No encontrado", { status: 404 });
      const post = await posts.get(id, { type: "json" });
      if (!post || (post.status !== "approved" && !admin)) return new Response("No encontrado", { status: 404 });
      const buf = await photos.get(id, { type: "arrayBuffer" });
      if (!buf) return new Response("No encontrado", { status: 404 });
      return new Response(buf, { headers: {
        "Content-Type": post.photoType || "image/jpeg",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": post.status === "approved" ? "public, max-age=86400" : "no-store"
      }});
    }

    if (action === "token") {
      const t = url.searchParams.get("t") || "";
      const tk = TK.test(t) ? await tokens.get(t, { type: "json" }) : null;
      const left = tk ? tk.products.filter((p) => !(tk.done || []).includes(p.id)) : [];
      if (!left.length) return json({ error: "Este enlace no es válido o ya fue utilizado." }, 404);
      return json({
        products: left,
        customerName: tk.customerName || "",
        customerId: tk.customerId || "",
        orderRef: tk.orderRef || tk.ref || ""
      });
    }

    return json({ error: "Acción inválida" }, 400);
  }
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  if (action === "moderate" || action === "issue-token") {
    if (!admin) return json({ error: "No autorizado" }, 401);
    const b = await req.json().catch(() => ({}));

    if (action === "moderate") {
      const id = String(b.id || "");
      const post = TK.test(id) ? await posts.get(id, { type: "json" }) : null;
      if (!post) return json({ error: "No encontrado" }, 404);
      if (b.op === "delete") {
        await posts.delete(id);
        await photos.delete(id);
        return json({ ok: true });
      }
      if (b.op === "approve") post.status = "approved";
      else if (b.op === "reject") { post.status = "rejected"; post.featured = false; }
      else if (b.op === "feature") post.featured = !post.featured;
      else return json({ error: "Operación inválida" }, 400);
      await posts.setJSON(id, post);
      return json({ ok: true });
    }

    const products = (Array.isArray(b.products) ? b.products : []).slice(0, 10)
      .map((p) => ({ id: String(p.id || ""), name: clean(p.name, 80) }))
      .filter((p) => ID.test(p.id) && p.name);
    if (!products.length) return json({ error: "Falta el producto" }, 400);

    const ref = clean(b.ref, 80);
    if (!ref) return json({ error: "La referencia del pedido es obligatoria" }, 400);
    const order = await orders.get("orders/" + ref, { type: "json" });
    if (!order || order.reference !== ref) return json({ error: "Pedido no encontrado" }, 404);
    if (order.paymentStatus !== "aprobado") return json({ error: "La compra todavía no está confirmada por Bold" }, 409);
    const purchasedIds = new Set((Array.isArray(order.items) ? order.items : []).map(p => String(p.id)));
    if (products.some(p => !purchasedIds.has(p.id))) {
      return json({ error: "El enlace incluye un producto que no pertenece al pedido aprobado" }, 400);
    }

    const customerName = clean(b.customerName || order.name || "", 120);
    const customerId = clean(b.customerId || ("order:" + order.reference), 120);
    const t = crypto.randomBytes(12).toString("hex");
    await tokens.setJSON(t, {
      products,
      ref,
      orderRef: order.reference,
      customerId,
      customerName,
      done: [],
      processing: {},
      created: Date.now()
    });

    return json({
      token: t,
      url: url.origin + "/comunidad.html?t=" + t,
      customerName,
      orderRef: order?.reference || ref
    });
  }

  let f;
  try { f = await req.formData(); }
  catch { return json({ error: "Formulario inválido" }, 400); }

  if (f.get("empresa")) return json({ ok: true });

  const product = clean(f.get("product"), 60);
  const productName = clean(f.get("productName"), 80);
  const rating = Math.round(Number(f.get("rating")));
  const text = clean(f.get("text"), 500);
  const ig = clean(f.get("instagram"), 40).replace(/^@/, "");
  const customerName = clean(f.get("customerName"), 120);
  const clientId = clean(f.get("clientId"), 120);
  const file = f.get("photo");
  const hasPhoto = !!file && typeof file === "object" && file.size > 0;

  if (!ID.test(product) || !productName) return json({ error: "Producto no válido" }, 400);
  if (!(rating >= 1 && rating <= 5)) return json({ error: "Elige tu calificación" }, 400);
  // Evita duplicados accidentales en nuevos envíos del mismo navegador/cliente.
  // No modifica ni elimina reseñas existentes; las reseñas rechazadas sí pueden reenviarse.
  if (clientId) {
    const { blobs: existingBlobs } = await posts.list();
    for (const b of existingBlobs) {
      const existing = await posts.get(b.key, { type: "json" });
      if (
        existing &&
        existing.product === product &&
        existing.clientId === clientId &&
        existing.status !== "rejected"
      ) {
        return json({ error: "Ya recibimos una reseña para este producto." }, 409);
      }
    }
  }
  if (ig && !/^[A-Za-z0-9._]{1,30}$/.test(ig)) return json({ error: "Usuario de Instagram no válido" }, 400);
  if (!hasPhoto && !text) return json({ error: "Escribe una reseña o sube una fotografía" }, 400);

  let buf = null;
  let photoType = "image/jpeg";
  if (hasPhoto) {
    if (f.get("consent") !== "1") return json({ error: "Necesitamos tu autorización para usar la fotografía" }, 400);
    if (file.size > 3 * 1024 * 1024) return json({ error: "La fotografía es demasiado pesada" }, 400);
    buf = await file.arrayBuffer();
    const h = new Uint8Array(buf);
    const isJpeg = h[0] === 0xff && h[1] === 0xd8;
    const isPng = h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47;
    const isWebp = h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 &&
      h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50;
    if (!isJpeg && !isPng && !isWebp) return json({ error: "Sube una fotografía JPG, PNG o WEBP" }, 400);
    photoType = isPng ? "image/png" : isWebp ? "image/webp" : "image/jpeg";
  }

  let verified = false;
  let orderRef = "";
  let customerId = clientId || "";
  let verifiedCustomerName = customerName;
  const t = clean(f.get("token"), 40);
  let tokenClaim = null;
  let tokenSnapshot = null;
  let tokenEtag = "";
  if (t) {
    const tkResult = TK.test(t) ? await tokens.getWithMetadata(t, { type: "json", consistency: "strong" }) : null;
    const tk = tkResult?.data || null;
    if (!tk || !Array.isArray(tk.products) || !tk.products.some((p) => p.id === product) || (tk.done || []).includes(product)) {
      return json({ error: "Este enlace no es válido para este modelo o ya fue utilizado." }, 400);
    }
    if (tk.processing?.[product]) {
      return json({ error: "Esta opinión ya está siendo procesada. Intenta de nuevo en unos segundos." }, 409);
    }

    const reviewId = crypto.randomBytes(12).toString("hex");
    const claimed = {
      ...tk,
      processing: { ...(tk.processing || {}), [product]: { reviewId, startedAt: Date.now() } }
    };
    const claimResult = await tokens.setJSON(t, claimed, { onlyIfMatch: tkResult.etag });
    if (claimResult?.modified && !claimResult?.etag) return json({ error: "No se pudo reservar el enlace de compra." }, 503);
    if (!claimResult?.modified) return json({ error: "Esta opinión ya está siendo procesada. Intenta de nuevo." }, 409);

    verified = true;
    orderRef = clean(tk.orderRef || tk.ref, 80);
    customerId = clean(tk.customerId || ("order:" + orderRef), 120);
    verifiedCustomerName = clean(tk.customerName || customerName, 120);
    tokenClaim = { token: t, product, reviewId };
    tokenSnapshot = claimed;
    tokenEtag = claimResult.etag;
    f.set("reviewId", reviewId);
  }
  const id = tokenClaim?.reviewId || crypto.randomBytes(12).toString("hex");
  const kind = hasPhoto ? (text ? "look+review" : "look") : "review";
  const lookId = product;
  try {
    if (buf) await photos.set(id, buf);
    await posts.setJSON(id, {
      id, product, productName, rating, text, instagram: ig,
      customerName: verifiedCustomerName, customerId, orderRef,
      kind, lookId, verified, featured: false,
      hasPhoto, photoType: hasPhoto ? photoType : "", consent: hasPhoto,
      status: "pending", created: Date.now()
    });

    if (tokenClaim) {
      const latest = await tokens.getWithMetadata(tokenClaim.token, { type: "json", consistency: "strong" });
      if (!latest?.data) throw new Error("No se encontró el enlace de compra para finalizarlo");
      const processing = latest.data.processing?.[tokenClaim.product];
      if (!processing || processing.reviewId !== tokenClaim.reviewId) {
        throw new Error("El enlace de compra cambió durante el envío");
      }
      const processingNext = { ...(latest.data.processing || {}) };
      delete processingNext[tokenClaim.product];
      const done = Array.from(new Set([...(latest.data.done || []), tokenClaim.product]));
      const finalized = { ...latest.data, processing: processingNext, done };
      const finalWrite = await tokens.setJSON(tokenClaim.token, finalized, { onlyIfMatch: latest.etag });
      if (finalWrite?.modified && !finalWrite?.etag) throw new Error("No se pudo confirmar el consumo del enlace");
      if (!finalWrite?.modified) throw new Error("El enlace cambió durante el envío");
    }

    return json({ ok: true });
  } catch (error) {
    if (tokenClaim) {
      try {
        const latest = await tokens.getWithMetadata(tokenClaim.token, { type: "json", consistency: "strong" });
        const processing = latest?.data?.processing?.[tokenClaim.product];
        if (latest?.data && processing?.reviewId === tokenClaim.reviewId) {
          const processingNext = { ...(latest.data.processing || {}) };
          delete processingNext[tokenClaim.product];
          await tokens.setJSON(tokenClaim.token, { ...latest.data, processing: processingNext }, { onlyIfMatch: latest.etag });
        }
      } catch (releaseError) {
        console.error("No se pudo liberar el token de Comunidad:", releaseError);
      }
    }
    console.error("No se pudo guardar la reseña:", error);
    return json({ error: "No se pudo guardar la opinión. Intenta de nuevo." }, 500);
  }
};
