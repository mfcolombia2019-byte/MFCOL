import { store, listJson, json, requireAdmin } from "./_admin.mjs";
import { getCatalogProduct } from "./_catalog.mjs";
import { validateInventoryInput, LOW_STOCK } from "./_admin-data.mjs";

// Existencias por variante. Prefijo independiente "inventory/<productId>". Es un registro
// manual del administrador con historial (cantidad anterior, nueva, ajuste y motivo):
// NO se descuenta al vender (el checkout no lo lee) y NO modifica "products/", "catalog/"
// ni lo que ve la tienda. Clave de variante: "color|talla" si el producto tiene colores,
// "talla" si no.

const MAX_HISTORY = 300;

// Resuelve color/tallas del producto: catálogo base (servidor) o producto del panel.
async function resolveProduct(id) {
  const base = getCatalogProduct(id);
  if (base) {
    return { colors: base.colors || [], sizes: (base.facts || []).filter(f => /^\d{2}$/.test(String(f))).map(String) };
  }
  const record = await store.get("catalog/" + id, { type: "json", consistency: "strong" });
  if (record && record.source === "panel" && record.status !== "archivado") return { colors: record.colors || [], sizes: record.sizes || [] };
  return null;
}

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    return json({ inventory: await listJson("inventory/"), lowStock: LOW_STOCK });
  }
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const productId = String(body?.productId || "").trim();
  const product = await resolveProduct(productId);
  if (!product) return json({ error: "Producto no encontrado o archivado" }, 404);

  const checked = validateInventoryInput(body, product);
  if (checked.errors) return json({ error: checked.errors[0], errors: checked.errors }, 400);
  const { reason, changes } = checked.value;

  const key = "inventory/" + productId;
  const now = new Date().toISOString();
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  const before = current?.data || null;
  const stock = { ...(before?.stock || {}) };
  const entries = [];
  for (const [variant, qty] of Object.entries(changes)) {
    const prev = Object.prototype.hasOwnProperty.call(stock, variant) ? stock[variant] : null;
    if (prev === qty) continue;
    entries.push({ at: now, key: variant, before: prev, after: qty, delta: prev === null ? null : qty - prev, reason });
    stock[variant] = qty;
  }
  if (!entries.length) return json({ ok: true, unchanged: true, inventory: before });

  const next = {
    productId, stock,
    createdAt: before?.createdAt || now, updatedAt: now,
    history: [...(before?.history || []), ...entries].slice(-MAX_HISTORY)
  };
  const result = before
    ? await store.setJSON(key, next, { onlyIfMatch: current.etag })
    : await store.setJSON(key, next, { onlyIfNew: true });
  if (result?.modified === false) return json({ error: "El inventario cambió mientras lo editabas. Recarga e inténtalo de nuevo." }, 409);
  return json({ ok: true, inventory: next, changed: entries.length });
};
