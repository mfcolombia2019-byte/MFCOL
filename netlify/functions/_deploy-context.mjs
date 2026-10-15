/**
 * Resolve Netlify's deploy context from the runtime handler first.
 * CONTEXT is often available at build time but is not guaranteed at runtime.
 */
export function resolveDeployContext(handlerContext, env = process.env) {
  const fromHandler = String(handlerContext?.deploy?.context || "").trim().toLowerCase();
  if (fromHandler) return fromHandler;
  return String(env?.CONTEXT || "").trim().toLowerCase();
}

export const PRODUCTION_STORE_NAME = "mfc-admin";
export const NONPROD_STORE_NAME = "mfc-admin-nonprod";

/**
 * Single source of truth for which Blobs store a deploy context may touch.
 * Only the production context uses the production store; every other or
 * unknown context is isolated in the non-production store.
 */
export function storeNameForContext(contextName) {
  return String(contextName || "").trim().toLowerCase() === "production"
    ? PRODUCTION_STORE_NAME
    : NONPROD_STORE_NAME;
}

/**
 * True when the store a module bound at load time is the one this invocation's
 * deploy context is allowed to use. An unknown active store (stubbed module) is
 * treated as "cannot compare" and passes.
 */
export function storeMatchesContext(contextName, activeStoreName) {
  if (!activeStoreName) return true;
  return storeNameForContext(contextName) === activeStoreName;
}
