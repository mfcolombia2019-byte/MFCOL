import { store, listJson, json, requireAdmin } from "./_admin.mjs";
import { getCatalogProduct } from "./_catalog.mjs";
import {
  validateProductInput, isValidProductId, normalizePhotoPath,
  PRODUCT_STATUSES, COLLECTIONS, SIZES
} from "./_admin-data.mjs";

// Productos del panel. Registro en "catalog/<id>" del almacén administrativo (producción y
// no producción ya están separados por _admin.mjs). Esta función NO toca el checkout, ni
// "orders/", ni "_catalog.mjs": los productos creados aquí quedan guardados y administrables,
// pero solo se publican en la tienda y se aceptan en el checkout cuando se aplique la
// sincronización aislada descrita en docs/admin-panel-fase3.md.
//
// - Los productos del catálogo base (productos.js / _catalog.mjs) son de solo lectura salvo
//   SKU, costo y visibilidad. Su precio y datos públicos no se pueden cambiar desde aquí.
// - Archivar no borra nada: es reversible y queda en el historial.
// - El costo y las notas son internos: toPublicProduct() nunca los expone.

const KEY = (id) => "catalog/" + id;
const SKU_KEY = (sku) => "catalog-sku/" + String(sku).toUpperCase();
const MAX_HISTORY = 60;
const BASE_ONLY = new Set(["sku", "cost"]);

async function read(id) {
  return await store.getWithMetadata(KEY(id), { type: "json", consistency: "strong" });
}

// Comprueba que la foto existe en este mismo sitio. Solo rutas assets/... (ya normalizadas).
async function checkPhoto(origin, path) {
  try {
    const res = await fetch(new URL("/" + path, origin), { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4000) });
    const type = res.headers.get("content-type") || "";
    if (res.status === 200 && /^image\//i.test(type)) return { path, ok: true, status: 200, contentType: type };
    return { path, ok: false, status: res.status, error: res.status === 200 ? "El archivo no es una imagen." : "No existe (HTTP " + res.status + ")." };
  } catch {
    return { path, ok: false, status: 0, error: "No se pudo comprobar la foto (sin respuesta del sitio)." };
  }
}

async function claimSku(sku, productId) {
  const result = await store.setJSON(SKU_KEY(sku), { productId, at: new Date().toISOString() }, { onlyIfNew: true });
  if (result?.modified !== false) return { ok: true, created: true };
  const owner = await store.get(SKU_KEY(sku), { type: "json", consistency: "strong" });
  return { ok: owner?.productId === productId, created: false };
}
async function releaseSku(sku, productId) {
  if (!sku) return;
  const owner = await store.get(SKU_KEY(sku), { type: "json", consistency: "strong" });
  if (owner?.productId === productId) await store.delete(SKU_KEY(sku));
}

function baseRecord(id, now) {
  return { id, source: "estatico", status: "activo", sku: "", cost: null, createdAt: now, updatedAt: now, history: [] };
}

// Para productos del catálogo base la visibilidad ya la aplica la tienda desde "products/<id>.active"
// (mismo mecanismo de admin-api). Se fusiona con el registro existente y nunca escribe precio.
async function mirrorStorefrontActive(id, active, now) {
  const current = (await store.get("products/" + id, { type: "json" })) || {};
  await store.setJSON("products/" + id, { ...current, id, active, updatedAt: now });
}

export default async (req) => {
  const auth = requireAdmin(req);
  if (auth) return auth;

  if (req.method === "GET") {
    const products = await listJson("catalog/");
    products.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    return json({ products, options: { statuses: PRODUCT_STATUSES, collections: COLLECTIONS, sizes: SIZES } });
  }
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
  const action = String(body?.action || "");
  const origin = new URL(req.url).origin;
  const now = new Date().toISOString();

  if (action === "verify-photo") {
    const path = normalizePhotoPath(body?.path);
    if (!path) return json({ error: "Ruta de foto no válida. Usa una ruta existente dentro de assets/." }, 400);
    return json(await checkPhoto(origin, path));
  }

  const id = String(body?.id || "").trim();

  if (action === "create") {
    if (!isValidProductId(id)) return json({ error: "El identificador debe ser un texto en minúsculas con guiones (3 a 80 caracteres)." }, 400);
    if (getCatalogProduct(id)) return json({ error: "Ese identificador ya existe en el catálogo base." }, 409);
    const checked = validateProductInput(body, { mode: "create" });
    if (checked.errors) return json({ error: checked.errors[0], errors: checked.errors }, 400);
    const v = checked.value;

    const photoResults = await Promise.all(v.imgs.map(i => checkPhoto(origin, i.path)));
    const badPhoto = photoResults.find(r => !r.ok);
    if (badPhoto) return json({ error: "Foto «" + badPhoto.path + "»: " + badPhoto.error, photos: photoResults }, 400);

    const exists = await read(id);
    if (exists?.data) return json({ ok: true, duplicate: true, product: exists.data });

    let claimed = false;
    if (v.sku) {
      const claim = await claimSku(v.sku, id);
      if (!claim.ok) return json({ error: "Ese SKU ya está en uso por otro producto." }, 409);
      claimed = claim.created;
    }
    const product = {
      id, source: "panel", status: body?.status === "activo" ? "activo" : "inactivo", sku: "", cost: null, description: "", category: "", collection: "",
      colors: [], isNew: false, order: 0, ...v, createdAt: now, updatedAt: now, photosCheckedAt: now,
      history: [{ at: now, action: "create" }]
    };
    // Un producto nuevo nace inactivo (borrador) salvo que se pida "activo" de forma explícita.
    const result = await store.setJSON(KEY(id), product, { onlyIfNew: true });
    if (result?.modified === false) {
      if (claimed) await releaseSku(v.sku, id);
      const again = await read(id);
      return json({ ok: true, duplicate: true, product: again?.data ?? null });
    }
    return json({ ok: true, product }, 201);
  }

  if (!isValidProductId(id)) return json({ error: "Producto no válido" }, 400);
  const isBase = !!getCatalogProduct(id);
  const current = await read(id);
  if (!current?.data && !isBase) return json({ error: "Producto no encontrado" }, 404);
  const before = current?.data || baseRecord(id, now);

  const write = async (next) => {
    const result = current?.data
      ? await store.setJSON(KEY(id), next, { onlyIfMatch: current.etag })
      : await store.setJSON(KEY(id), next, { onlyIfNew: true });
    return result?.modified !== false;
  };

  if (action === "set-status") {
    const status = String(body?.status || "");
    if (!PRODUCT_STATUSES.includes(status)) return json({ error: "Estado no válido (activo, inactivo o archivado)." }, 400);
    if (before.status === status) return json({ ok: true, product: before });
    const reason = String(body?.reason || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
    const next = {
      ...before, status, updatedAt: now,
      history: [...(before.history || []), { at: now, action: "status", from: before.status, to: status, reason }].slice(-MAX_HISTORY)
    };
    if (!(await write(next))) return json({ error: "El producto cambió mientras lo editabas. Recarga e inténtalo de nuevo." }, 409);
    if (isBase) await mirrorStorefrontActive(id, status === "activo", now);
    return json({ ok: true, product: next });
  }

  if (action === "update") {
    if (before.status === "archivado") return json({ error: "El producto está archivado. Restáuralo antes de editarlo." }, 409);
    const checked = validateProductInput(body, { mode: "update" });
    if (checked.errors) return json({ error: checked.errors[0], errors: checked.errors }, 400);
    const v = checked.value;
    if (isBase) {
      const blocked = Object.keys(v).filter(k => !BASE_ONLY.has(k));
      if (blocked.length) return json({ error: "Producto del catálogo base: desde el panel solo se editan SKU y costo. El precio y los datos públicos se mantienen en productos.js." }, 403);
    }
    const changed = Object.keys(v).filter(k => JSON.stringify(v[k]) !== JSON.stringify(before[k] ?? (k === "cost" ? null : undefined)));
    if (!changed.length) return json({ ok: true, product: before, unchanged: true });

    if (changed.includes("imgs")) {
      const known = new Set((before.imgs || []).map(i => i.path));
      const fresh = v.imgs.filter(i => !known.has(i.path));
      const results = await Promise.all(fresh.map(i => checkPhoto(origin, i.path)));
      const bad = results.find(r => !r.ok);
      if (bad) return json({ error: "Foto «" + bad.path + "»: " + bad.error, photos: results }, 400);
    }

    let claimed = false;
    if (changed.includes("sku") && v.sku) {
      const claim = await claimSku(v.sku, id);
      if (!claim.ok) return json({ error: "Ese SKU ya está en uso por otro producto." }, 409);
      claimed = claim.created;
    }
    const previous = Object.fromEntries(changed.map(k => [k, before[k] ?? null]));
    const next = {
      ...before, ...v, updatedAt: now,
      ...(changed.includes("imgs") ? { photosCheckedAt: now } : {}),
      history: [...(before.history || []), { at: now, action: "update", changed, previous }].slice(-MAX_HISTORY)
    };
    if (!(await write(next))) {
      if (claimed) await releaseSku(v.sku, id);
      return json({ error: "El producto cambió mientras lo editabas. Recarga e inténtalo de nuevo." }, 409);
    }
    if (changed.includes("sku") && before.sku && before.sku !== v.sku) await releaseSku(before.sku, id);
    return json({ ok: true, product: next });
  }

  return json({ error: "Acción no reconocida" }, 400);
};
