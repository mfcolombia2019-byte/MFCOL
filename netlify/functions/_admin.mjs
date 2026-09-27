import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

export const store = getStore("mfc-admin");

function secret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
}

function sign(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("hex");
}

export function sessionCookie(value) {
  return "mfc_admin=" + value + "." + sign(value) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800";
}

export function clearCookie() {
  return "mfc_admin=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

export function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  const part = raw.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

export function isAdmin(req) {
  const token = readCookie(req, "mfc_admin");
  if (!token || !secret()) return false;
  const i = token.lastIndexOf(".");
  if (i < 1) return false;
  const value = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = sign(value);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers }
  });
}

export function requireAdmin(req) {
  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_SESSION_SECRET) {
    return json({ error: "Admin sin configurar. Faltan ADMIN_PASSWORD y ADMIN_SESSION_SECRET." }, 503);
  }
  if (!isAdmin(req)) return json({ error: "No autorizado" }, 401);
  return null;
}

export function safeId(value, fallback = "") {
  const id = String(value || fallback).trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : "";
}

export async function getJson(key, fallback = null) {
  const value = await store.get(key, { type: "json" });
  return value == null ? fallback : value;
}

export async function listJson(prefix) {
  const { blobs } = await store.list({ prefix });
  const rows = [];
  for (const b of blobs) {
    const value = await store.get(b.key, { type: "json" });
    if (value != null) rows.push(value);
  }
  return rows;
}
