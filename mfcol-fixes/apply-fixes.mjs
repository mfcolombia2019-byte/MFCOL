#!/usr/bin/env node
// Uso (desde la raíz del repo MFCOL): node mfcol-fixes/apply-fixes.mjs
// Es atómico: si cualquier reemplazo no coincide exactamente, no escribe nada.
// Es idempotente: puedes ejecutarlo dos veces.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const here = import.meta.dirname;
const pending = new Map();
const log = [];
let failed = false;

function load(file) {
  if (pending.has(file)) return pending.get(file);
  const p = path.join(root, file);
  if (!fs.existsSync(p)) { log.push("✗ No existe " + file); failed = true; return null; }
  const s = fs.readFileSync(p, "utf8");
  pending.set(file, s);
  return s;
}
function edit(file, oldS, newS, label) {
  const src = load(file);
  if (src === null) return;
  const crlf = src.includes("\r\n");
  const o = crlf ? oldS.replace(/\n/g, "\r\n") : oldS;
  const n = crlf ? newS.replace(/\n/g, "\r\n") : newS;
  if (src.includes(n)) { log.push("· ya aplicado: " + label); return; }
  const count = src.split(o).length - 1;
  if (count !== 1) { log.push("✗ " + label + " (" + file + "): se esperaba 1 coincidencia y hay " + count); failed = true; return; }
  pending.set(file, src.replace(o, () => n));
  log.push("✓ " + label);
}

/* 1 · Webhook: aceptar llave de identidad Y llave secreta en producción */
const WH = "netlify/functions/bold-webhook.mjs";
edit(WH,
`export function validSignature(rawBody, signature, secret) {`,
`// Bold documenta la firma con "llave de identidad" en una página y con "llave
// secreta" en otra. En producción se acepta cualquiera de las dos (ambas son
// secretos del comercio); fuera de producción, la clave vacía de pruebas.
export function getBoldWebhookSecrets(env = process.env) {
  const context = String(env?.CONTEXT || "").trim().toLowerCase();
  if (context !== "production") return [""];
  return [env?.BOLD_API_KEY, env?.BOLD_SECRET_KEY].map(s => String(s || "")).filter(Boolean);
}

export function validSignature(rawBody, signature, secret) {`,
"webhook: getBoldWebhookSecrets");
edit(WH,
`  const secret = getBoldWebhookSecret();

  if (contextName === "production" && !secret) {
    console.error("BOLD_API_KEY no está configurada en producción");
    return new Response("Configuración de webhook incompleta", { status: 500 });
  }
  if (!validSignature(rawBody, signature, secret)) return new Response("Firma inválida", { status: 400 });`,
`  const secrets = getBoldWebhookSecrets();

  if (contextName === "production" && !secrets.length) {
    console.error("BOLD_API_KEY / BOLD_SECRET_KEY no están configuradas en producción");
    return new Response("Configuración de webhook incompleta", { status: 500 });
  }
  const matchedKey = secrets.findIndex(s => validSignature(rawBody, signature, s));
  if (matchedKey === -1) {
    console.error("Webhook Bold: firma inválida");
    return new Response("Firma inválida", { status: 400 });
  }
  console.log("Webhook Bold: firma válida con " + (contextName === "production" ? (matchedKey === 0 ? "llave de identidad" : "llave secreta") : "clave de pruebas"));`,
"webhook: validar con ambas llaves");

/* 2 · order-status: también reconciliar pedidos 'rechazado' (reintento aprobado) */
const OS = "netlify/functions/order-status.mjs";
edit(OS,
`  if (current.data.paymentStatus !== "pendiente") return current.data;`,
`  if (!["pendiente", "rechazado"].includes(current.data.paymentStatus)) return current.data;`,
"order-status: applyVerifiedApproval acepta rechazado");
edit(OS,
`    order.paymentStatus === "pendiente" &&`,
`    ["pendiente", "rechazado"].includes(order.paymentStatus) &&`,
"order-status: reconcilia rechazado");

/* 3 · gracias.html: un 'rechazado' no concluyente sigue consultando */
edit("gracias.html",
`if (data.paymentStatus === "rechazado" || data.paymentStatus === "anulado") { showNotApproved(data); running = false; return; }`,
`var inconclusive = data.paymentStatus === "rechazado" && (data.verification === "recent" || data.verification === "unavailable");
          if (!inconclusive && (data.paymentStatus === "rechazado" || data.paymentStatus === "anulado")) { showNotApproved(data); running = false; return; }`,
"gracias: rechazado no concluyente");

/* 4 · Meta CAPI: teléfono con 57, email y país hasheados */
const META = "netlify/functions/_meta.mjs";
edit(META,
`function normalizePhone(value) {
  return String(value || "").replace(/\\D/g, "");
}`,
`function normalizePhone(value) {
  const digits = String(value || "").replace(/\\D/g, "");
  // Celular colombiano de 10 dígitos: Meta espera el código de país.
  return digits.length === 10 && digits.startsWith("3") ? "57" + digits : digits;
}`,
"meta: teléfono con prefijo 57");
edit(META,
`  if (phone) userData.ph = [sha256(phone)];`,
`  if (phone) userData.ph = [sha256(phone)];
  if (order?.payerEmail) userData.em = [sha256(String(order.payerEmail).trim().toLowerCase())];
  userData.country = [sha256("co")];`,
"meta: em y country");

/* 5 · WhatsApp: correo real del pagador en la plantilla */
edit("netlify/functions/_whatsapp.mjs",
`{ type: "text", text: "No registrado" },`,
`{ type: "text", text: String(order.payerEmail || "No registrado").slice(0, 160) },`,
"whatsapp: correo del pagador");

/* 6 · netlify.toml: no servir código, pruebas ni documentos internos */
const TOML = "netlify.toml";
{
  const src = load(TOML);
  if (src !== null) {
    if (src.includes('from = "/netlify/*"')) log.push("· ya aplicado: netlify.toml redirects");
    else {
      const nl = src.includes("\r\n") ? "\r\n" : "\n";
      const block = ["/netlify/*", "/tests/*", "/docs/*", "/meta-feed/*", "/MIGRATION_VERIFY.md", "/package.json"]
        .map(f => `[[redirects]]\n  from = "${f}"\n  to = "/404.html"\n  status = 404\n  force = true\n`).join("\n")
        .replace(/\n/g, nl);
      pending.set(TOML, src.replace(/\s*$/, nl + nl) + block);
      log.push("✓ netlify.toml: bloquea /netlify, /tests, /docs, /meta-feed, MIGRATION_VERIFY.md y package.json");
    }
  }
}
/* nota: /meta-feed se bloquea; si Meta lee el CSV desde tu dominio, quita esa línea. */

/* 7 · package.json: script de pruebas */
{
  const src = load("package.json");
  if (src !== null) {
    const pkg = JSON.parse(src);
    pkg.scripts = pkg.scripts || {};
    if (pkg.scripts.test) log.push("· ya aplicado: package.json test");
    else {
      pkg.scripts.test = "node --test --experimental-test-module-mocks tests/*.test.mjs";
      pending.set("package.json", JSON.stringify(pkg, null, 2) + "\n");
      log.push("✓ package.json: npm test");
    }
  }
}

/* 8 · Documento desactualizado */
{
  const f = "docs/orders-payments-meta-security.md";
  const src = load(f);
  if (src !== null) {
    if (src.includes("## Actualización de flujos Bold (2026-10-14)")) log.push("· ya aplicado: docs");
    else {
      pending.set(f, src.replace(/\s*$/, "\n\n") + `## Actualización de flujos Bold (2026-10-14)

- Esta rama usa @netlify/blobs 10.7.12 (condicionales onlyIfNew/onlyIfMatch). Las secciones anteriores sobre 8.1.0 y "sin scheduler" quedaron obsoletas.
- Funciones programadas cada 5 min (solo corren en el deploy de producción): bold-webhook-retry, meta-outbox-retry, whatsapp-outbox.
- Webhook: en producción se acepta la firma con BOLD_API_KEY (llave de identidad) o BOLD_SECRET_KEY (llave secreta); fuera de producción, clave vacía. El log indica cuál validó.
- order-status y gracias.html reconcilian también pedidos en estado "rechazado" (reintento aprobado dentro del checkout de Bold).
- Meta CAPI: teléfono con prefijo 57, email (payer_email) y país hasheados.
`);
      log.push("✓ docs actualizado");
    }
  }
}

if (failed) {
  console.error(log.join("\n"));
  console.error("\nNo se escribió nada. Corrige lo marcado con ✗ y vuelve a ejecutar.");
  process.exit(1);
}

for (const [file, content] of pending) fs.writeFileSync(path.join(root, file), content);

/* Pruebas nuevas */
fs.mkdirSync(path.join(root, "tests"), { recursive: true });
for (const t of fs.readdirSync(path.join(here, "tests"))) {
  fs.copyFileSync(path.join(here, "tests", t), path.join(root, "tests", t));
  log.push("✓ tests/" + t);
}

/* Copias viejas en la raíz (no son funciones: se estaban publicando como archivos estáticos) */
for (const stale of ["bold-webhook.mjs", "comunidad.mjs", "crear-link-pago.mjs"]) {
  const p = path.join(root, stale);
  if (fs.existsSync(p)) { fs.rmSync(p); log.push("✓ eliminado " + stale + " de la raíz"); }
}

console.log(log.join("\n"));
console.log("\nListo. Ejecuta: npm test");
