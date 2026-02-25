/**
 * Verify Bearer token auth for admin endpoints.
 * Returns a 401 Response if unauthorized, or null if authorized.
 *
 * Usage:
 *   const denied = requireAdmin(request, env.ADMIN_SECRET);
 *   if (denied) return denied;
 */
export function requireAdmin(
  request: Request,
  adminSecret: string | undefined,
): Response | null {
  const auth = request.headers.get("Authorization");
  if (!adminSecret || auth !== `Bearer ${adminSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
