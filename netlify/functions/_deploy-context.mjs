/**
 * Resolve Netlify's deploy context from the runtime handler first.
 * CONTEXT is often available at build time but is not guaranteed at runtime.
 */
export function resolveDeployContext(handlerContext, env = process.env) {
  const fromHandler = String(handlerContext?.deploy?.context || "").trim().toLowerCase();
  if (fromHandler) return fromHandler;
  return String(env?.CONTEXT || "").trim().toLowerCase();
}
