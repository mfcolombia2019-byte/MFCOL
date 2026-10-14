import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.ADMIN_PASSWORD = "test-password";
process.env.ADMIN_SESSION_SECRET = "test-secret";

// Almacén en memoria que imita lo que usa el panel de @netlify/blobs.
const data = new Map();
const memoryStore = {
  async get(key, opts = {}) {
    if (!data.has(key)) return null;
    const v = data.get(key);
    if (opts.type === "json") return JSON.parse(v.toString());
    if (opts.type === "arrayBuffer") return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
    return v.toString();
  },
  async set(key, value) { data.set(key, Buffer.from(value)); },
  async setJSON(key, value) { data.set(key, Buffer.from(JSON.stringify(value))); return { modified: true, etag: "x" }; },
  async delete(key) { data.delete(key); },
  async list({ prefix = "" } = {}) {
    return { blobs: [...data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) };
  }
};
mock.module("@netlify/blobs", { exports: { getStore: () => memoryStore } });

const { sessionCookie } = await import("../netlify/functions/_admin.mjs");
const adminApi = (await import("../netlify/functions/admin-api.mjs")).default;
const storeConfig = (await import("../netlify/functions/store-config.mjs")).default;
const productImage = (await import("../netlify/functions/product-image.mjs")).default;
const { validateCart } = await import("../netlify/functions/_catalog.mjs");

const cookie = sessionCookie("admin").split(";")[0];
const call = (body) => adminApi(new Request("https://mfcol.com/.netlify/functions/admin-api", {
  method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body)
}));
const overridesFromStore = async () => {
  const out = {};
  for (const key of [...data.keys()].filter(k => k.startsWith("products/"))) {
    const p = JSON.parse(data.get(key).toString());
    out[p.id] = p;
  }
  return out;
};

// Sin sesión no se puede nada.
const anon = await adminApi(new Request("https://mfcol.com/.netlify/functions/admin-api", {
  method: "POST", body: JSON.stringify({ action: "create-product" })
}));
assert.equal(anon.status, 401);

// 1) Subir una foto (JPEG mínimo) y rechazar lo que no es JPEG.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
const up = await (await call({ action: "upload-image", data: jpeg })).json();
assert.match(up.url, /^\/\.netlify\/functions\/product-image\?k=[a-f0-9-]{36}$/);
const bad = await call({ action: "upload-image", data: Buffer.from("no soy jpeg").toString("base64") });
assert.equal(bad.status, 400);

// La foto se sirve públicamente.
const img = await productImage(new Request("https://mfcol.com" + up.url));
assert.equal(img.status, 200);
assert.equal(img.headers.get("content-type"), "image/jpeg");

// 2) Validaciones al crear.
assert.equal((await call({ action: "create-product", name: "", price: 200000, group: "tacones", colors: "Negro", imgs: [[up.url, ""]] })).status, 400);
assert.equal((await call({ action: "create-product", name: "Sin foto", price: 200000, group: "tacones", colors: "Negro", imgs: [] })).status, 400);
assert.equal((await call({ action: "create-product", name: "Foto ajena", price: 200000, group: "tacones", colors: "Negro", imgs: [["https://evil.example/x.jpg", ""]] })).status, 400);

// 3) Crear un producto de verdad.
const created = await (await call({
  action: "create-product", name: "Sandalia Piña Dorada", price: 229900, group: "tacones",
  category: "Punta abierta · Tacón alto", colors: "Dorado, Negro", desc: "Prueba", isNew: true, active: true,
  imgs: [[up.url, ""]]
})).json();
assert.equal(created.product.id, "sandalia-pina-dorada");
assert.equal(created.product.custom, true);

// 4) La tienda lo recibe por store-config.
const cfg = await (await storeConfig(new Request("https://mfcol.com/.netlify/functions/store-config"))).json();
const fromStore = cfg.products.find(p => p.id === "sandalia-pina-dorada");
assert.ok(fromStore, "store-config debe incluir el producto nuevo");
assert.equal(fromStore.price, 229900);

// 5) Se puede comprar: el servidor lo reconoce y usa su precio.
const cart = validateCart([{ id: "sandalia-pina-dorada", size: "37", color: "Dorado", qty: 2 }], await overridesFromStore());
assert.equal(cart.subtotal, 459800);
const overridesNow = await overridesFromStore();
assert.throws(() => validateCart([{ id: "sandalia-pina-dorada", size: "37", color: "Rojo", qty: 1 }], overridesNow), /Color inválido/);
// Sin los datos del panel, un id desconocido sigue rechazado.
assert.throws(() => validateCart([{ id: "sandalia-pina-dorada", size: "37", color: "Dorado", qty: 1 }]), /Producto no disponible/);

// 6) Nombre repetido → ID distinto, nunca pisa el anterior ni el catálogo original.
const second = await (await call({ action: "create-product", name: "Sandalia Piña Dorada", price: 100000, group: "plataformas", colors: "Negro", imgs: [[up.url, ""]] })).json();
assert.equal(second.product.id, "sandalia-pina-dorada-2");
const clash = await (await call({ action: "create-product", name: "Mule de tacón alto con tres tiras", price: 100000, group: "tacones", colors: "Negro", imgs: [[up.url, ""]] })).json();
assert.equal(clash.product.id, "mule-de-tacon-alto-con-tres-tiras-2");

// 7) Ajustes sobre un producto del catálogo original: precio y ocultar.
assert.equal((await call({ action: "save-product", id: "no-existe", name: "x", price: 1000 })).status, 404);
await call({ action: "save-product", id: "mule-de-tacon-alto-con-tres-tiras", name: "Mule de tacón alto con tres tiras", price: 150000, active: true });
const repriced = validateCart([{ id: "mule-de-tacon-alto-con-tres-tiras", size: "36", color: "Negro", qty: 1 }], await overridesFromStore());
assert.equal(repriced.subtotal, 150000, "el precio del panel debe ser el que se cobra");
await call({ action: "save-product", id: "mule-de-tacon-alto-con-tres-tiras", name: "Mule", price: 150000, active: false });
const overridesHidden = await overridesFromStore();
assert.throws(() => validateCart([{ id: "mule-de-tacon-alto-con-tres-tiras", size: "36", color: "Negro", qty: 1 }], overridesHidden), /Producto no disponible/);

// 8) Editar un producto creado: se quita una foto y se borra del almacén.
const up2 = await (await call({ action: "upload-image", data: jpeg })).json();
await call({ action: "save-product", id: "sandalia-pina-dorada", name: "Sandalia Piña Dorada", price: 239900, group: "tacones", colors: "Dorado", imgs: [[up2.url, ""]] });
assert.equal((await productImage(new Request("https://mfcol.com" + up.url))).status, 404, "la foto quitada debe borrarse");

// 9) Eliminar: solo productos creados en el panel.
assert.equal((await call({ action: "delete-product", id: "mule-de-tacon-alto-con-tres-tiras" })).status, 400);
assert.equal((await call({ action: "delete-product", id: "sandalia-pina-dorada" })).status, 200);
assert.equal((await productImage(new Request("https://mfcol.com" + up2.url))).status, 404);
assert.ok(!data.has("products/sandalia-pina-dorada"));

console.log("admin-products: ok");
