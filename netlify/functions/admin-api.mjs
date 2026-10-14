import crypto from "node:crypto";
import { store, getJson, listJson, json, requireAdmin, safeId } from "./_admin.mjs";
import { getCatalogProduct } from "./_catalog.mjs";

const GROUPS = new Set(["plataformas", "tacones"]);
const SIZES = ["34", "35", "36", "37", "38", "39", "40"];
const IMAGE_URL = /^\/\.netlify\/functions\/product-image\?k=[a-f0-9-]{36}$/;
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_IMAGES = 8;

function slugify(text) {
  return String(text || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function cleanList(value, maxItems, maxLen) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const out = [];
  for (const item of raw) {
    const v = String(item).trim().slice(0, maxLen);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parsePrice(value) {
  if (value === "" || value == null) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 20000000) return NaN;
  return n;
}

function parseStock(value) {
  if (value === "" || value == null) return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

// Las fotos llegan como [url, alt]; solo se aceptan las subidas desde este panel.
function cleanImages(value, productName) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of list.slice(0, MAX_IMAGES)) {
    const url = String(Array.isArray(item) ? item[0] : item || "");
    if (!IMAGE_URL.test(url)) continue;
    const alt = String((Array.isArray(item) ? item[1] : "") || (productName + " — foto " + (out.length + 1))).slice(0, 160);
    out.push([url, alt]);
  }
  return out;
}

function imageKey(url) {
  const m = /k=([a-f0-9-]{36})$/.exec(String(url));
  return m ? "product-images/" + m[1] : "";
}

async function uniqueProductId(name) {
  const base = slugify(name) || "producto";
  let id = base, n = 2;
  while (getCatalogProduct(id) || await store.get("products/" + id, { type: "json" })) {
    id = base + "-" + n++;
    if (n > 200) throw new Error("No se pudo generar un ID para el producto");
  }
  return id;
}

function buildCustomFields(body, existing) {
  const name = String(body.name || "").trim().slice(0, 120);
  if (!name) return { error: "El nombre es obligatorio" };

  const price = parsePrice(body.price);
  if (price === null || Number.isNaN(price) || price < 1000) return { error: "Escribe un precio válido (mínimo $1.000)" };

  const group = String(body.group || "");
  if (!GROUPS.has(group)) return { error: "Elige una categoría: Plataformas o Tacones" };

  const colors = cleanList(body.colors, 12, 30);
  if (!colors.length) return { error: "Escribe al menos un color" };

  const imgs = cleanImages(body.imgs, name);
  if (!imgs.length) return { error: "Sube al menos una foto del producto" };

  return {
    fields: {
      ...(existing || {}),
      custom: true,
      name,
      price,
      group,
      category: String(body.category || "").trim().slice(0, 120),
      colors,
      desc: String(body.desc || "").trim().slice(0, 600),
      imgs,
      isNew: body.isNew === true,
      active: body.active !== false,
      stock: parseStock(body.stock),
      updatedAt: new Date().toISOString()
    }
  };
}

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    const url = new URL(req.url);
    const section = url.searchParams.get("section") || "dashboard";

    if (section === "dashboard") {
      const products = await listJson("products/");
      return json({
        stats: {
          custom: products.filter(p => p.custom).length,
          hidden: products.filter(p => p.active === false).length,
          adjusted: products.filter(p => !p.custom).length
        }
      });
    }

    if (section === "products") return json({ products: await listJson("products/") });
    if (section === "settings") return json({ settings: await getJson("settings", {}) });

    return json({ error: "Sección no encontrada" }, 404);
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "JSON inválido" }, 400); }

  const action = String(body?.action || "");

  // Sube una foto (JPEG ya reducida por el navegador) y devuelve su URL pública.
  if (action === "upload-image") {
    const buf = Buffer.from(String(body.data || ""), "base64");
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return json({ error: "La foto es demasiado grande o está vacía" }, 400);
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return json({ error: "La foto debe ser JPG" }, 400);
    const k = crypto.randomUUID();
    await store.set("product-images/" + k, buf, { metadata: { contentType: "image/jpeg" } });
    return json({ ok: true, url: "/.netlify/functions/product-image?k=" + k });
  }

  // Crea un producto nuevo: aparece en la tienda y se puede comprar.
  if (action === "create-product") {
    const built = buildCustomFields(body, null);
    if (built.error) return json({ error: built.error }, 400);
    const id = await uniqueProductId(body.name);
    const product = { id, ...built.fields, createdAt: new Date().toISOString() };
    await store.setJSON("products/" + id, product);
    return json({ ok: true, product });
  }

  if (action === "save-product") {
    const id = safeId(body.id);
    if (!id) return json({ error: "ID de producto inválido" }, 400);

    const existing = await store.get("products/" + id, { type: "json" });

    // Producto creado desde el panel: se edita completo.
    if (existing?.custom) {
      const built = buildCustomFields(body, existing);
      if (built.error) return json({ error: built.error }, 400);
      const product = { ...built.fields, id };
      await store.setJSON("products/" + id, product);
      // Borra las fotos que se quitaron.
      const keep = new Set(product.imgs.map(i => imageKey(i[0])));
      for (const [url] of existing.imgs || []) {
        const key = imageKey(url);
        if (key && !keep.has(key)) await store.delete(key);
      }
      return json({ ok: true, product });
    }

    // Producto del catálogo original: solo ajustes (nombre, precio, categoría, activo, stock).
    if (!getCatalogProduct(id)) return json({ error: "Ese producto no existe" }, 404);
    const price = parsePrice(body.price);
    if (Number.isNaN(price)) return json({ error: "Precio inválido" }, 400);
    const product = {
      id,
      name: String(body.name || "").trim().slice(0, 120),
      price,
      active: body.active !== false,
      category: String(body.category || "").trim().slice(0, 120),
      stock: parseStock(body.stock),
      updatedAt: new Date().toISOString()
    };
    await store.setJSON("products/" + id, product);
    return json({ ok: true, product });
  }

  // Solo se eliminan productos creados desde el panel; los del catálogo original se ocultan.
  if (action === "delete-product") {
    const id = safeId(body.id);
    const existing = id ? await store.get("products/" + id, { type: "json" }) : null;
    if (!existing?.custom) return json({ error: "Solo se pueden eliminar productos creados desde el panel. Los demás se ocultan." }, 400);
    await store.delete("products/" + id);
    for (const [url] of existing.imgs || []) {
      const key = imageKey(url);
      if (key) await store.delete(key);
    }
    return json({ ok: true });
  }

  if (action === "save-settings") {
    const current = await getJson("settings", {});
    const settings = {
      ...current,
      brandMessage: String(body.brandMessage ?? current.brandMessage ?? "").slice(0, 300),
      whatsapp: String(body.whatsapp ?? current.whatsapp ?? "").replace(/\D/g, "").slice(0, 20),
      instagram: String(body.instagram ?? current.instagram ?? "").slice(0, 80),
      email: String(body.email ?? current.email ?? "").slice(0, 160),
      updatedAt: new Date().toISOString()
    };
    await store.setJSON("settings", settings);
    return json({ ok: true, settings });
  }

  return json({ error: "Acción no reconocida" }, 400);
};
