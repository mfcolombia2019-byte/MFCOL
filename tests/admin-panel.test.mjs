import assert from "node:assert/strict";
import { mock, test, beforeEach } from "node:test";
import { readFileSync } from "node:fs";

// Almacén en memoria con la misma semántica de escrituras condicionales que Netlify Blobs.
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

const expenses = (await import("../netlify/functions/admin-expenses.mjs")).default;
const shipping = (await import("../netlify/functions/admin-shipping.mjs")).default;
const inventory = (await import("../netlify/functions/admin-inventory.mjs")).default;
const adminApi = (await import("../netlify/functions/admin-api.mjs")).default;
const lib = await import("../netlify/functions/_admin-data.mjs");

const URL_ = "https://example.test/.netlify/functions/";
const post = (fn, name, body) => fn(new Request(URL_ + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const get = (fn, name, q = "") => fn(new Request(URL_ + name + q));
const PID = "sandalia-slide-de-plataforma-alta-en-cuatro-colores";
const goodExpense = { description: "Publicidad Instagram", category: "publicidad", amount: 30000, date: "2026-10-05", paymentMethod: "tarjeta" };

beforeEach(() => { data.clear(); writes.length = 0; globalThis.__denyAdmin = false; afterRead = null; });

const seedOrder = (o) => data.set("orders/" + o.reference, { data: o, etag: "o" + (++etagSeq) });

// ---------- autenticación ----------
test("todas las funciones nuevas rechazan sin sesión de administrador (GET y POST)", async () => {
  globalThis.__denyAdmin = true;
  for (const [fn, name] of [[expenses, "admin-expenses"], [shipping, "admin-shipping"], [inventory, "admin-inventory"]]) {
    assert.equal((await get(fn, name)).status, 401, name + " GET");
    assert.equal((await post(fn, name, {})).status, 401, name + " POST");
  }
  assert.equal(writes.length, 0);
});

// ---------- gastos ----------
test("crear gasto persiste, se vuelve a leer y es idempotente con el mismo id", async () => {
  const body = { action: "create", id: "gx_prueba1", ...goodExpense };
  const r1 = await post(expenses, "admin-expenses", body);
  assert.equal(r1.status, 201);
  const r2 = await post(expenses, "admin-expenses", { ...body, amount: 99999 });
  assert.equal(r2.status, 200);
  const d2 = await r2.json();
  assert.equal(d2.duplicate, true);
  assert.equal(d2.expense.amount, 30000, "el reintento no sobrescribe ni duplica");
  const list = await (await get(expenses, "admin-expenses", "?month=2026-10")).json();
  assert.equal(list.expenses.length, 1);
  assert.equal(writes.filter(k => k.startsWith("expenses/")).length, 1);
  assert.equal(writes.some(k => !k.startsWith("expenses/")), false);
});

test("validación de gastos: importe, fecha, categoría, método y descripción", async () => {
  for (const bad of [
    { amount: 0 }, { amount: -5 }, { amount: 10.5 }, { amount: "abc" }, { amount: 2e9 },
    { date: "2026-02-31" }, { date: "05/10/2026" }, { date: "2099-01-01" },
    { category: "magia" }, { paymentMethod: "bitcoin" }, { description: "" }, { reference: "no válida!" }, { recurrence: "diaria" }
  ]) {
    const r = await post(expenses, "admin-expenses", { action: "create", ...goodExpense, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(writes.length, 0);
});

test("editar gasto conserva historial, anular no borra y un gasto anulado no se edita", async () => {
  await post(expenses, "admin-expenses", { action: "create", id: "gx_a", ...goodExpense });
  const up = await post(expenses, "admin-expenses", { action: "update", id: "gx_a", ...goodExpense, amount: 45000 });
  const upd = (await up.json()).expense;
  assert.equal(upd.amount, 45000);
  assert.equal(upd.history.at(-1).previous.amount, 30000);
  const v = await post(expenses, "admin-expenses", { action: "void", id: "gx_a", reason: "duplicado" });
  assert.equal((await v.json()).expense.voided, true);
  assert.ok(data.has("expenses/gx_a"), "anular no elimina el registro");
  assert.equal((await post(expenses, "admin-expenses", { action: "update", id: "gx_a", ...goodExpense })).status, 409);
  assert.equal((await post(expenses, "admin-expenses", { action: "update", id: "gx_zz", ...goodExpense })).status, 404);
});

test("edición concurrente: si el gasto cambia entre lectura y escritura responde 409 y no pisa", async () => {
  await post(expenses, "admin-expenses", { action: "create", id: "gx_c", ...goodExpense });
  afterRead = (key) => { data.get(key).etag = "otro-proceso"; };
  const r = await post(expenses, "admin-expenses", { action: "update", id: "gx_c", ...goodExpense, amount: 1 });
  assert.equal(r.status, 409);
  assert.equal(data.get("expenses/gx_c").data.amount, 30000);
});

// ---------- finanzas ----------
test("resumen financiero: aprobado, pendiente y rechazado separados; sin doble conteo; neto = aprobado − gastos", async () => {
  const t = Date.parse("2026-10-10T15:00:00Z");
  seedOrder({ reference: "MFA", total: 200000, status: "nuevo", paymentStatus: "aprobado", createdAt: "2026-10-10T15:00:00Z", paymentEventTime: t / 1000, confirmedAmount: 200000 });
  seedOrder({ reference: "MFB", total: 100000, status: "nuevo", paymentStatus: "pendiente", createdAt: "2026-10-11T15:00:00Z" });
  seedOrder({ reference: "MFC", total: 50000, status: "nuevo", paymentStatus: "rechazado", createdAt: "2026-10-12T15:00:00Z" });
  seedOrder({ reference: "MFD", total: 70000, status: "cancelado", paymentStatus: "pendiente", createdAt: "2026-10-12T16:00:00Z" });
  await post(expenses, "admin-expenses", { action: "create", id: "gx_1", ...goodExpense, amount: 30000 });
  await post(expenses, "admin-expenses", { action: "create", id: "gx_2", ...goodExpense, amount: 5000, recurrence: "mensual" });
  await post(expenses, "admin-expenses", { action: "create", id: "gx_3", ...goodExpense, amount: 7777 });
  await post(expenses, "admin-expenses", { action: "void", id: "gx_3" });
  const d = await (await get(expenses, "admin-expenses", "?month=2026-10")).json();
  assert.deepEqual(d.summary.approved, { count: 1, total: 200000 });
  assert.deepEqual(d.summary.pending, { count: 1, total: 100000 }, "el pedido cancelado no cuenta como pendiente");
  assert.deepEqual(d.summary.rejected, { count: 1, total: 50000 });
  assert.equal(d.summary.ordersCreated.count, 4);
  assert.equal(d.summary.expenses.total, 35000, "el gasto anulado no suma");
  assert.equal(d.summary.expenses.recurring, 1);
  assert.equal(d.summary.net, 200000 - 35000);
  assert.equal(d.summary.byMonth["2026-10"].net, 165000);
});

test("el pago aprobado usa el importe confirmado por Bold y la fecha del pago en hora de Bogotá", () => {
  const paid = Date.parse("2026-11-01T02:00:00Z") / 1000; // 31-oct 21:00 en Bogotá
  const s = lib.summarizeFinance([
    { reference: "X", total: 100000, paymentStatus: "aprobado", createdAt: "2026-10-31T20:00:00Z", paymentEventTime: paid, confirmedAmount: 98000 }
  ], [], "2026-10");
  assert.equal(s.approved.total, 98000);
  assert.equal(lib.summarizeFinance([{ reference: "X", total: 1, paymentStatus: "aprobado", createdAt: "2026-10-31T20:00:00Z", paymentEventTime: paid }], [], "2026-11").approved.count, 0);
});

test("sin datos reales devuelve ceros, no cifras inventadas", async () => {
  const d = await (await get(expenses, "admin-expenses")).json();
  assert.equal(d.summary.approved.total, 0);
  assert.equal(d.summary.net, 0);
  assert.deepEqual(d.expenses, []);
});

// ---------- despachos ----------
test("despacho: exige pedido real, guarda solo en shipping/ y no toca el pago ni el pedido", async () => {
  seedOrder({ reference: "MF1", total: 190000, status: "nuevo", paymentStatus: "pendiente", createdAt: "2026-10-10T15:00:00Z" });
  const before = structuredClone(data.get("orders/MF1").data);
  const r = await post(shipping, "admin-shipping", { reference: "MF1", status: "despachado", carrier: "Servientrega", guide: "SV123456", shippedAt: "2026-10-12" });
  assert.equal(r.status, 200);
  assert.deepEqual(data.get("orders/MF1").data, before, "el pedido queda idéntico");
  assert.equal(data.get("orders/MF1").data.paymentStatus, "pendiente");
  assert.equal(writes.every(k => k.startsWith("shipping/")), true);
  const list = await (await get(shipping, "admin-shipping")).json();
  assert.equal(list.shipping.length, 1);
  assert.equal(list.shipping[0].history.length, 1);
  assert.equal((await post(shipping, "admin-shipping", { reference: "NOEXISTE", status: "preparando" })).status, 404);
});

test("despacho: validaciones (guía obligatoria, fechas, estado) y pedido cancelado", async () => {
  seedOrder({ reference: "MF2", total: 1, status: "nuevo", paymentStatus: "aprobado", createdAt: "2026-10-10T15:00:00Z" });
  seedOrder({ reference: "MF3", total: 1, status: "cancelado", paymentStatus: "pendiente", createdAt: "2026-10-10T15:00:00Z" });
  for (const bad of [
    { status: "despachado" }, { status: "despachado", carrier: "X", guide: "a b" }, { status: "volando" },
    { status: "preparando", shippedAt: "2026-13-01" }, { status: "entregado", carrier: "X", guide: "ABC123", shippedAt: "2026-10-12" },
    { status: "entregado", carrier: "X", guide: "ABC123", shippedAt: "2026-10-12", deliveredAt: "2026-10-11" }
  ]) assert.equal((await post(shipping, "admin-shipping", { reference: "MF2", ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await post(shipping, "admin-shipping", { reference: "MF3", status: "despachado", carrier: "X", guide: "ABC123" })).status, 409);
  assert.equal(writes.length, 0);
});

test("despacho: dos actualizaciones conservan el historial y el conflicto concurrente responde 409", async () => {
  seedOrder({ reference: "MF4", total: 1, status: "nuevo", paymentStatus: "aprobado", createdAt: "2026-10-10T15:00:00Z" });
  await post(shipping, "admin-shipping", { reference: "MF4", status: "preparando" });
  await post(shipping, "admin-shipping", { reference: "MF4", status: "despachado", carrier: "TCC", guide: "TCC0001" });
  assert.equal(data.get("shipping/MF4").data.history.length, 2);
  afterRead = (key) => { data.get(key).etag = "otro"; };
  const r = await post(shipping, "admin-shipping", { reference: "MF4", status: "en_transito", carrier: "TCC", guide: "TCC0001" });
  assert.equal(r.status, 409);
  assert.equal(data.get("shipping/MF4").data.status, "despachado");
});

// ---------- inventario (por color y talla, con historial) ----------
test("inventario: ajusta por color y talla, registra anterior/nueva/motivo y valida", async () => {
  const r = await post(inventory, "admin-inventory", { productId: PID, reason: "Conteo inicial", changes: { "Negro|36": 2, "Negro|37": 3 } });
  assert.equal(r.status, 200);
  const r2 = await post(inventory, "admin-inventory", { productId: PID, reason: "Venta en tienda", changes: { "Negro|37": 1, "Rosa|38": 5 } });
  const inv = (await r2.json()).inventory;
  assert.deepEqual(inv.stock, { "Negro|36": 2, "Negro|37": 1, "Rosa|38": 5 });
  const h = inv.history.filter(x => x.key === "Negro|37");
  assert.deepEqual([h[1].before, h[1].after, h[1].delta, h[1].reason], [3, 1, -2, "Venta en tienda"]);
  assert.equal(inv.history.find(x => x.key === "Rosa|38").before, null, "sin registro previo, no se inventa una cantidad anterior");
  for (const bad of [{ "Negro|36": -1 }, { "Negro|36": 1.5 }, { "Negro|36": "x" }, { "36": 1 }, { "Naranja|36": 1 }, { "Negro|99": 1 }, { "Negro|36": 100000 }]) {
    assert.equal((await post(inventory, "admin-inventory", { productId: PID, reason: "x y z", changes: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post(inventory, "admin-inventory", { productId: PID, reason: "", changes: { "Negro|36": 1 } })).status, 400, "el motivo es obligatorio");
  assert.equal((await post(inventory, "admin-inventory", { productId: "no-existe", reason: "abc", changes: { "36": 1 } })).status, 404);
  assert.equal(writes.every(k => k.startsWith("inventory/")), true, "no escribe en products/, catalog/ ni orders/");
});

test("inventario: sin cambios no escribe y el conflicto concurrente responde 409", async () => {
  await post(inventory, "admin-inventory", { productId: PID, reason: "Conteo", changes: { "Negro|36": 2 } });
  const n = writes.length;
  const same = await post(inventory, "admin-inventory", { productId: PID, reason: "Conteo", changes: { "Negro|36": 2 } });
  assert.equal((await same.json()).unchanged, true);
  assert.equal(writes.length, n);
  afterRead = (key) => { data.get(key).etag = "otro"; };
  assert.equal((await post(inventory, "admin-inventory", { productId: PID, reason: "Conteo", changes: { "Negro|36": 9 } })).status, 409);
  assert.equal(data.get("inventory/" + PID).data.stock["Negro|36"], 2);
});

// ---------- precios de solo lectura ----------
test("admin-api: los precios son de solo lectura y guardar 'active' no borra otros campos", async () => {
  data.set("products/p1", { data: { id: "p1", name: "Nombre guardado", category: "Cat" }, etag: "e0" });
  const denied = await post(adminApi, "admin-api", { action: "save-product", id: "p1", price: 1 });
  assert.equal(denied.status, 403);
  assert.equal(data.get("products/p1").data.price, undefined);
  const ok = await post(adminApi, "admin-api", { action: "save-product", id: "p1", active: false });
  const p = (await ok.json()).product;
  assert.equal(p.active, false);
  assert.equal(p.name, "Nombre guardado");
  assert.equal("price" in p, false, "no se crea un precio nulo que anularía el de la tienda");
});

// ---------- aislamiento de flujos protegidos ----------
test("las funciones nuevas no importan ni escriben flujos protegidos (Bold, checkout, pedidos, WhatsApp)", () => {
  for (const f of ["admin-expenses", "admin-shipping", "admin-inventory", "admin-catalog", "_admin-data"]) {
    const src = readFileSync(new URL("../netlify/functions/" + f + ".mjs", import.meta.url), "utf8");
    assert.equal(/_orders|_bold|_whatsapp|_meta|crear-link-pago|bold-status|order-status/.test(src), false, f);
    assert.equal(/setJSON\(\s*["']orders\//.test(src), false, f + " no escribe pedidos");
    assert.equal(/process\.env/.test(src), false, f + " no lee secretos");
  }
});

test("admin.html no usa localStorage para datos comerciales ni datos de demostración", () => {
  const html = readFileSync(new URL("../admin.html", import.meta.url), "utf8");
  assert.equal(/seed\s*\(/.test(html), false);
  assert.equal(/localStorage\.(setItem|getItem)\(\s*K\b/.test(html), false);
  assert.equal(/Ejemplo Clienta|Otra Clienta|Publicidad Instagram/.test(html), false);
});
