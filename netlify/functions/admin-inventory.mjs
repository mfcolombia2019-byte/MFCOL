import { store, listJson, json, requireAdmin } from "./_admin.mjs";
import { getCatalogProduct } from "./_catalog.mjs";
import { validateInventoryInput } from "./_admin-data.mjs";

// Existencias por talla. Prefijo independiente "inventory/<productId>". Es un registro
// manual del administrador: NO se descuenta automáticamente al vender (el checkout no
// lo lee) y NO modifica "products/" ni el catálogo que ve la tienda.

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    return json({ inventory: await listJson("inventory/") });
  }
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const productId = String(body?.productId || "").trim();
  const product = getCatalogProduct(productId);
  if (!product) return json({ error: "Producto no encontrado en el catálogo" }, 404);
  const knownSizes = (product.facts || []).filter(f => /^\d{2}$/.test(String(f))).map(String);

  const checked = validateInventoryInput(body, knownSizes);
  if (checked.errors) return json({ error: checked.errors[0], errors: checked.errors }, 400);

  const key = "inventory/" + productId;
  const now = new Date().toISOString();
  const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  const before = current?.data || null;
  const next = {
    productId,
    sizes: { ...(before?.sizes || {}), ...checked.value.sizes },
    createdAt: before?.createdAt || now,
    updatedAt: now
  };
  const result = before
    ? await store.setJSON(key, next, { onlyIfMatch: current.etag })
    : await store.setJSON(key, next, { onlyIfNew: true });
  if (result?.modified === false) return json({ error: "El inventario cambió mientras lo editabas. Recarga e inténtalo de nuevo." }, 409);
  return json({ ok: true, inventory: next });
};
