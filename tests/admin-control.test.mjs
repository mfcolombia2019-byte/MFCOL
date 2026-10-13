import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = new Map();
let denied = null;

const clone = value => value == null ? value : structuredClone(value);
const store = {
  async get(key) {
    return clone(state.get(key) ?? null);
  },
  async setJSON(key, value) {
    state.set(key, clone(value));
    return { modified: true, etag: '"test-etag"' };
  }
};

const adminUrl = new URL("../netlify/functions/_admin.mjs", import.meta.url).href;
mock.module(adminUrl, {
  exports: {
    store,
    getJson: async (key, fallback = null) => state.has(key) ? clone(state.get(key)) : fallback,
    listJson: async prefix => [...state.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => clone(value)),
    json: (data, status = 200, headers = {}) => Response.json(data, {
      status,
      headers: { "Cache-Control": "no-store", ...headers }
    }),
    requireAdmin: () => denied,
    safeId: value => {
      const id = String(value || "").trim();
      return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : "";
    }
  }
});

const { default: handler } = await import("../netlify/functions/admin-control.mjs");

function reset() {
  state.clear();
  denied = null;
}

function req(method, url, body) {
  return new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
}

async function body(response) {
  return response.json();
}

test("finanzas calcula ingresos, costos, gastos y señala unidades sin costo", async () => {
  reset();
  state.set("orders/MF-FIN-1", {
    reference: "MF-FIN-1",
    paymentStatus: "aprobado",
    total: 100000,
    items: [{ id: "modelo-1", qty: 2 }, { id: "modelo-2", qty: 1 }]
  });
  state.set("orders/MF-FIN-2", {
    reference: "MF-FIN-2",
    paymentStatus: "pendiente",
    total: 50000,
    items: [{ id: "modelo-1", qty: 1 }]
  });
  state.set("finance-costs/modelo-1", { productId: "modelo-1", name: "Modelo 1", unitCost: 30000 });
  state.set("finance-expenses/expense-1", { id: "expense-1", amount: 5000, description: "Empaques", category: "Empaques", date: "2026-10-13" });

  const response = await handler(req("GET", "https://example.test/.netlify/functions/admin-control?section=finance"));
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(result.summary.revenue, 100000);
  assert.equal(result.summary.costOfGoods, 60000);
  assert.equal(result.summary.expenses, 5000);
  assert.equal(result.summary.profit, 35000);
  assert.equal(result.summary.missingCostUnits, 1);
});

test("registra costos por modelo y gastos con validación", async () => {
  reset();
  let response = await handler(req("POST", "https://example.test/.netlify/functions/admin-control", {
    action: "save-cost", productId: "modelo-1", name: "Sandalia", unitCost: "42000"
  }));
  assert.equal(response.status, 200);
  assert.equal((await body(response)).cost.unitCost, 42000);

  response = await handler(req("POST", "https://example.test/.netlify/functions/admin-control", {
    action: "save-expense", description: "Pauta", category: "Publicidad", amount: "15000", date: "2026-10-13"
  }));
  assert.equal(response.status, 200);
  assert.equal((await body(response)).expense.amount, 15000);

  response = await handler(req("POST", "https://example.test/.netlify/functions/admin-control", {
    action: "save-expense", description: "", category: "Publicidad", amount: "-1", date: "invalid"
  }));
  assert.equal(response.status, 400);
});

test("inventario guarda y devuelve una variante por color y talla", async () => {
  reset();
  const response = await handler(req("POST", "https://example.test/.netlify/functions/admin-control", {
    action: "save-inventory", productId: "modelo-1", name: "Sandalia", color: "Negro", size: "36", stock: "4"
  }));
  assert.equal(response.status, 200);
  const result = await handler(req("GET", "https://example.test/.netlify/functions/admin-control?section=inventory"));
  const data = await body(result);
  assert.equal(data.variants.length, 1);
  assert.equal(data.variants[0].color, "Negro");
  assert.equal(data.variants[0].size, 36);
  assert.equal(data.variants[0].stock, 4);
});

test("despacho se guarda en un registro separado sin cambiar el estado del pedido", async () => {
  reset();
  state.set("orders/MF-SHIP-1", {
    reference: "MF-SHIP-1", status: "preparando", paymentStatus: "aprobado",
    items: [{ id: "modelo-1", name: "Sandalia", color: "Negro", size: "36", qty: 1 }]
  });
  const response = await handler(req("POST", "https://example.test/.netlify/functions/admin-control", {
    action: "save-dispatch", reference: "MF-SHIP-1", status: "en_transito", trackingNumber: "GUIA123"
  }));
  assert.equal(response.status, 200);
  assert.equal(state.get("orders/MF-SHIP-1").status, "preparando");
  assert.equal(state.get("orders/MF-SHIP-1").paymentStatus, "aprobado");
  const result = await handler(req("GET", "https://example.test/.netlify/functions/admin-control?section=dispatches"));
  const data = await body(result);
  assert.equal(data.orders[0].dispatch.status, "en_transito");
  assert.equal(data.orders[0].dispatch.trackingNumber, "GUIA123");
});

test("no permite registrar despachos para pedidos inexistentes", async () => {
  reset();
  const response = await handler(req("POST", "https://example.test/.netlify/functions/admin-control", {
    action: "save-dispatch", reference: "NO-EXISTE", status: "en_transito"
  }));
  assert.equal(response.status, 404);
});

test("la API del panel exige una sesión de administrador", async () => {
  reset();
  denied = Response.json({ error: "No autorizado" }, { status: 401 });
  const response = await handler(req("GET", "https://example.test/.netlify/functions/admin-control?section=inventory"));
  assert.equal(response.status, 401);
});
