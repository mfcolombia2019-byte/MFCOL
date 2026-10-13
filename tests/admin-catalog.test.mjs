import assert from "node:assert/strict";
import { mock, test, beforeEach } from "node:test";
import { readFileSync } from "node:fs";

// Almacén en memoria con la semántica de escrituras condicionales de Netlify Blobs.
const data = new Map();
const writes = [];
let etagSeq = 0;
let afterRead = null;
const store = {
  async get(key) { const e = data.get(key); return e ? structuredClone(e.data) : null; },
  async getWithMetadata(key) {
    const e = data.get(key);
    const out = e ? { data: structuredClone(e.data), etag: e.etag } : null;
    if (afterRead) { const f = afterRead; afterRead = null; f(key); }
    return out;
  },
  async setJSON(key, value, opts = {}) {
    const e = data.get(key);
    if (opts.onlyIfNew && e) return { modified: false };
    if (opts.onlyIfMatch && (!e || e.etag !== opts.onlyIfMatch)) return { modified: false };
    const etag = "etag-" + (++etagSeq);
    data.set(key, { data: structuredClone(value), etag });
    writes.push(key);
    return { modified: true, etag };
  },
  async delete(key) { data.delete(key); },
  async list({ prefix }) { return { blobs: [...data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; }
};

mock.module("../netlify/functions/_admin.mjs", {
  exports: {
    store,
    json: (d, status = 200, headers = {}) => Response.json(d, { status, headers: { "Cache-Control": "no-store", ...headers } }),
    requireAdmin: () => globalThis.__denyAdmin ? Response.json({ error: "No autorizado" }, { status: 401 }) : null,
    safeId: (v, f = "") => { const id = String(v || f).trim(); return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : ""; },
    getJson: async (key, fallback = null) => (await store.get(key)) ?? fallback,
    listJson: async (prefix) => { const { blobs } = await store.list({ prefix }); return Promise.all(blobs.map(b => store.get(b.key))); }
  }
});

const catalog = (await import("../netlify/functions/admin-catalog.mjs")).default;
const inventory = (await import("../netlify/functions/admin-inventory.mjs")).default;
const expenses = (await import("../netlify/functions/admin-expenses.mjs")).default;
const lib = await import("../netlify/functions/_admin-data.mjs");

const URL_ = "https://tienda.example.test/.netlify/functions/";
const post = (fn, name, body) => fn(new Request(URL_ + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const get = (fn, name) => fn(new Request(URL_ + name));
const BASE_ID = "mule-de-tacon-alto-con-tres-tiras"; // producto del catálogo base (_catalog.mjs)

const good = (over = {}) => ({
  action: "create", id: "sandalia-prueba-uno", name: "Sandalia de prueba uno", description: "Descripción de prueba",
  price: 150000, category: "Punta abierta", collection: "tacones", sku: "SKU-001",
  imgs: [{ path: "assets/foto-ok.jpg", alt: "Foto ok" }], colors: ["Negro", "Blanco"], sizes: ["36", "37", "38"], order: 5, ...over
});

let photoOk = new Set(["/assets/foto-ok.jpg", "/assets/foto-ok-2.jpg"]);
let fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  fetchCalls.push({ url: u.href, method: init.method });
  if (u.origin !== "https://tienda.example.test") throw new Error("solo se debe consultar el propio sitio: " + u.href);
  if (globalThis.__photoDown) throw new Error("red caída");
  if (photoOk.has(u.pathname)) return new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } });
  if (u.pathname === "/assets/no-imagen.jpg") return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
  return new Response(null, { status: 404 });
};

beforeEach(() => { data.clear(); writes.length = 0; fetchCalls = []; globalThis.__denyAdmin = false; globalThis.__photoDown = false; afterRead = null; });

// ---------- autenticación ----------
test("productos: sin sesión se rechaza lectura y escritura", async () => {
  globalThis.__denyAdmin = true;
  assert.equal((await get(catalog, "admin-catalog")).status, 401);
  assert.equal((await post(catalog, "admin-catalog", good())).status, 401);
  assert.equal((await post(inventory, "admin-inventory", {})).status, 401);
  assert.equal(writes.length, 0);
  assert.equal(fetchCalls.length, 0, "sin sesión no se hace ni una consulta de fotos");
});

// ---------- crear / consultar / editar ----------
test("crear producto: se guarda, se recupera al volver a consultar y nace inactivo (borrador)", async () => {
  const r = await post(catalog, "admin-catalog", good());
  assert.equal(r.status, 201);
  const list = (await (await get(catalog, "admin-catalog")).json()).products;
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.id, "sandalia-prueba-uno");
  assert.equal(p.price, 150000);
  assert.equal(p.status, "inactivo");
  assert.equal(p.source, "panel");
  assert.deepEqual(p.imgs, [{ path: "assets/foto-ok.jpg", alt: "Foto ok" }]);
  assert.deepEqual(p.colors, ["Negro", "Blanco"]);
  assert.deepEqual(p.sizes, ["36", "37", "38"]);
  assert.equal(writes.some(k => !k.startsWith("catalog/") && !k.startsWith("catalog-sku/")), false);
});

test("crear con la misma solicitud dos veces no duplica ni sobrescribe", async () => {
  await post(catalog, "admin-catalog", good());
  const again = await post(catalog, "admin-catalog", good({ price: 999999, name: "Otro nombre" }));
  assert.equal((await again.json()).duplicate, true);
  const list = (await (await get(catalog, "admin-catalog")).json()).products;
  assert.equal(list.length, 1);
  assert.equal(list[0].price, 150000);
});

test("editar producto: no lo duplica, conserva fotos y variantes y guarda historial con valores previos", async () => {
  await post(catalog, "admin-catalog", good());
  const r = await post(catalog, "admin-catalog", { action: "update", id: "sandalia-prueba-uno", price: 175000, name: "Nombre nuevo" });
  const p = (await r.json()).product;
  assert.equal(p.price, 175000);
  assert.equal(p.name, "Nombre nuevo");
  assert.deepEqual(p.imgs, [{ path: "assets/foto-ok.jpg", alt: "Foto ok" }], "las fotos se conservan");
  assert.deepEqual(p.sizes, ["36", "37", "38"], "las tallas se conservan");
  assert.deepEqual(p.colors, ["Negro", "Blanco"]);
  const last = p.history.at(-1);
  assert.deepEqual(last.changed.sort(), ["name", "price"]);
  assert.equal(last.previous.price, 150000);
  assert.equal((await (await get(catalog, "admin-catalog")).json()).products.length, 1);
  const same = await post(catalog, "admin-catalog", { action: "update", id: "sandalia-prueba-uno", price: 175000 });
  assert.equal((await same.json()).unchanged, true);
});

test("validación: precio, nombre, tallas, fotos, id, colección, orden y campos desconocidos", async () => {
  for (const bad of [
    { price: 0 }, { price: 999 }, { price: -5 }, { price: 10.5 }, { price: "abc" }, { price: 30000000 },
    { name: "ab" }, { sizes: [] }, { sizes: ["41"] }, { sizes: ["33"] }, { imgs: [] },
    { imgs: [{ path: "https://externo.example/foto.jpg" }] }, { imgs: [{ path: "assets/../secreto.jpg" }] }, { imgs: [{ path: "foto.txt" }] },
    { collection: "ofertas" }, { sku: "a b" }, { order: -1 }, { cost: -1 }
  ]) {
    const r = await post(catalog, "admin-catalog", good(bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  for (const id of ["Mayusculas", "con espacio", "ab", "-guion", "a".repeat(81), "../x"]) {
    assert.equal((await post(catalog, "admin-catalog", good({ id }))).status, 400, id);
  }
  assert.equal(writes.length, 0, "ningún dato inválido llega a guardarse");
  assert.equal(fetchCalls.length, 0, "no se consultan fotos si los datos ya son inválidos");
});

test("asignación masiva: campos sensibles enviados por el cliente se ignoran", async () => {
  const r = await post(catalog, "admin-catalog", good({ source: "estatico", history: [{ x: 1 }], createdAt: "2000-01-01", photosCheckedAt: "2000-01-01", status: "archivado" }));
  const p = (await r.json()).product;
  assert.equal(p.source, "panel");
  assert.equal(p.status, "inactivo", "el estado inicial solo puede ser activo o inactivo");
  assert.notEqual(p.createdAt, "2000-01-01");
  assert.deepEqual(p.history.map(h => h.action), ["create"]);
});

test("el identificador no puede coincidir con un producto del catálogo base", async () => {
  assert.equal((await post(catalog, "admin-catalog", good({ id: BASE_ID }))).status, 409);
  assert.equal(writes.length, 0);
});

// ---------- fotos ----------
test("fotos: solo rutas del mismo sitio, verificadas con HEAD; si no existe o no es imagen se rechaza", async () => {
  const missing = await post(catalog, "admin-catalog", good({ imgs: [{ path: "assets/no-existe.jpg" }] }));
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /no-existe\.jpg.*404/);
  assert.equal((await post(catalog, "admin-catalog", good({ imgs: [{ path: "assets/no-imagen.jpg" }] }))).status, 400);
  globalThis.__photoDown = true;
  const down = await post(catalog, "admin-catalog", good());
  assert.equal(down.status, 400, "si no se puede comprobar la foto no se guarda como verificada");
  assert.equal(writes.length, 0);
  globalThis.__photoDown = false;
  assert.equal((await post(catalog, "admin-catalog", good())).status, 201);
  assert.ok(fetchCalls.every(c => c.method === "HEAD" && c.url.startsWith("https://tienda.example.test/assets/")));
});

test("verificar foto por separado y editar fotos solo comprueba las nuevas", async () => {
  const ok = await (await post(catalog, "admin-catalog", { action: "verify-photo", path: "/assets/foto-ok.jpg" })).json();
  assert.equal(ok.ok, true);
  const bad = await (await post(catalog, "admin-catalog", { action: "verify-photo", path: "assets/nada.jpg" })).json();
  assert.equal(bad.ok, false);
  assert.equal((await post(catalog, "admin-catalog", { action: "verify-photo", path: "http://evil.test/a.jpg" })).status, 400);
  await post(catalog, "admin-catalog", good());
  fetchCalls = [];
  const r = await post(catalog, "admin-catalog", { action: "update", id: "sandalia-prueba-uno", imgs: [{ path: "assets/foto-ok.jpg" }, { path: "assets/foto-ok-2.jpg" }] });
  assert.equal(r.status, 200);
  assert.deepEqual(fetchCalls.map(c => new URL(c.url).pathname), ["/assets/foto-ok-2.jpg"]);
  const p = (await r.json()).product;
  assert.deepEqual(p.imgs.map(i => i.path), ["assets/foto-ok.jpg", "assets/foto-ok-2.jpg"]);
});

// ---------- SKU ----------
test("SKU único: otro producto no puede usarlo y liberarlo permite reutilizarlo", async () => {
  await post(catalog, "admin-catalog", good());
  const dup = await post(catalog, "admin-catalog", good({ id: "sandalia-prueba-dos", sku: "sku-001" }));
  assert.equal(dup.status, 409, "sin distinguir mayúsculas");
  assert.equal(data.has("catalog/sandalia-prueba-dos"), false);
  await post(catalog, "admin-catalog", { action: "update", id: "sandalia-prueba-uno", sku: "SKU-777" });
  assert.equal((await post(catalog, "admin-catalog", good({ id: "sandalia-prueba-dos", sku: "SKU-001" }))).status, 201, "el SKU liberado se puede reutilizar");
});

// ---------- activar / desactivar / archivar ----------
test("activar, desactivar, archivar y restaurar: reversible, con historial y sin borrar", async () => {
  await post(catalog, "admin-catalog", good());
  const set = async (status, reason) => (await (await post(catalog, "admin-catalog", { action: "set-status", id: "sandalia-prueba-uno", status, reason })).json()).product;
  assert.equal((await set("activo")).status, "activo");
  assert.equal((await set("inactivo", "sin stock")).status, "inactivo");
  const archived = await set("archivado", "descontinuado");
  assert.equal(archived.status, "archivado");
  assert.ok(data.has("catalog/sandalia-prueba-uno"), "archivar no elimina el registro");
  assert.equal((await post(catalog, "admin-catalog", { action: "update", id: "sandalia-prueba-uno", price: 200000 })).status, 409, "archivado no se edita");
  const restored = await set("inactivo", "restaurado");
  assert.equal(restored.price, 150000);
  assert.deepEqual(restored.history.filter(h => h.action === "status").map(h => h.to), ["activo", "inactivo", "archivado", "inactivo"]);
  assert.equal((await post(catalog, "admin-catalog", { action: "set-status", id: "sandalia-prueba-uno", status: "borrado" })).status, 400);
  assert.equal((await post(catalog, "admin-catalog", { action: "set-status", id: "no-existe-xx", status: "activo" })).status, 404);
});

test("edición concurrente: si el producto cambia entre lectura y escritura responde 409 y no pisa", async () => {
  await post(catalog, "admin-catalog", good());
  afterRead = (key) => { data.get(key).etag = "otro-proceso"; };
  const r = await post(catalog, "admin-catalog", { action: "update", id: "sandalia-prueba-uno", price: 111111 });
  assert.equal(r.status, 409);
  assert.equal(data.get("catalog/sandalia-prueba-uno").data.price, 150000);
});

// ---------- productos del catálogo base ----------
test("catálogo base: el precio y los datos públicos no se editan; SKU, costo y visibilidad sí", async () => {
  const denied = await post(catalog, "admin-catalog", { action: "update", id: BASE_ID, price: 1000 });
  assert.equal(denied.status, 403);
  assert.equal((await post(catalog, "admin-catalog", { action: "update", id: BASE_ID, name: "Otro" })).status, 403);
  const ok = await post(catalog, "admin-catalog", { action: "update", id: BASE_ID, sku: "MULE-3T", cost: 90000 });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).product.cost, 90000);
  data.set("products/" + BASE_ID, { data: { id: BASE_ID, name: "Nombre guardado" }, etag: "p0" });
  const hide = await post(catalog, "admin-catalog", { action: "set-status", id: BASE_ID, status: "inactivo", reason: "prueba" });
  assert.equal(hide.status, 200);
  const mirror = data.get("products/" + BASE_ID).data;
  assert.equal(mirror.active, false, "la tienda lee la visibilidad de products/<id>.active");
  assert.equal(mirror.name, "Nombre guardado");
  assert.equal("price" in mirror, false, "nunca se crea un precio que anule el de la tienda");
});

// ---------- inventario de productos del panel y costos ----------
test("inventario de un producto del panel por color y talla; archivado deja de aceptar ajustes", async () => {
  await post(catalog, "admin-catalog", good());
  const r = await post(inventory, "admin-inventory", { productId: "sandalia-prueba-uno", reason: "Conteo inicial", changes: { "Negro|36": 4, "Blanco|38": 1 } });
  assert.equal(r.status, 200);
  assert.equal((await post(inventory, "admin-inventory", { productId: "sandalia-prueba-uno", reason: "abc", changes: { "Negro|40": 1 } })).status, 400, "la talla 40 no es de este producto");
  await post(catalog, "admin-catalog", { action: "set-status", id: "sandalia-prueba-uno", status: "archivado" });
  assert.equal((await post(inventory, "admin-inventory", { productId: "sandalia-prueba-uno", reason: "abc", changes: { "Negro|36": 1 } })).status, 404);
  assert.equal(data.get("inventory/sandalia-prueba-uno").data.stock["Negro|36"], 4, "archivar no borra las existencias");
});

test("costo de mercancía: solo con costos registrados; si faltan, no se inventa utilidad", async () => {
  data.set("orders/MFA", { data: { reference: "MFA", total: 300000, paymentStatus: "aprobado", createdAt: new Date().toISOString(), items: [{ id: "p-con-costo", qty: 2 }, { id: "p-sin-costo", qty: 1 }] }, etag: "o" });
  await post(catalog, "admin-catalog", good({ id: "p-con-costo", sku: "", cost: 50000 }));
  const d = await (await get(expenses, "admin-expenses")).json();
  assert.equal(d.summary.cogs.total, 100000);
  assert.equal(d.summary.cogs.unknownUnits, 1);
  assert.deepEqual(d.summary.cogs.unknownProducts, ["p-sin-costo"]);
});

// ---------- publicación segura ----------
test("registro público: solo productos del panel activos y nunca costo, notas, SKU interno ni historial", async () => {
  await post(catalog, "admin-catalog", good({ cost: 80000 }));
  const rec = data.get("catalog/sandalia-prueba-uno").data;
  assert.equal(lib.toPublicProduct(rec), null, "inactivo no se publica");
  await post(catalog, "admin-catalog", { action: "set-status", id: "sandalia-prueba-uno", status: "activo" });
  const pub = lib.toPublicProduct(data.get("catalog/sandalia-prueba-uno").data);
  assert.deepEqual(Object.keys(pub).sort(), ["cardBg", "cat", "colors", "desc", "facts", "group", "id", "imgs", "isNew", "name", "order", "price"]);
  assert.equal(JSON.stringify(pub).includes("80000"), false);
  assert.equal(JSON.stringify(pub).includes("history"), false);
  assert.deepEqual(pub.imgs, [["assets/foto-ok.jpg", "Foto ok"]]);
  assert.equal(lib.toPublicProduct({ ...rec, source: "estatico", status: "activo" }), null);
});

// ---------- aislamiento de flujos protegidos ----------
test("las funciones de productos no importan ni escriben checkout, Bold, pedidos ni WhatsApp", () => {
  for (const f of ["admin-catalog", "admin-inventory"]) {
    const src = readFileSync(new URL("../netlify/functions/" + f + ".mjs", import.meta.url), "utf8");
    assert.equal(/_orders|_bold|_whatsapp|_meta|crear-link-pago|bold-status|order-status|validateCart/.test(src), false, f);
    assert.equal(/setJSON\(\s*["']orders\//.test(src), false, f);
    assert.equal(/process\.env/.test(src), false, f + " no lee secretos");
  }
  const catalogMirror = readFileSync(new URL("../netlify/functions/_catalog.mjs", import.meta.url), "utf8");
  assert.equal(/catalog\//.test(catalogMirror), false, "_catalog.mjs sigue sin leer el almacén: el checkout no cambió");
  const orders = readFileSync(new URL("../netlify/functions/orders.mjs", import.meta.url), "utf8");
  assert.match(orders, /validateCart\(body\?\.items\)/, "orders.mjs sigue validando con el catálogo base");
});
