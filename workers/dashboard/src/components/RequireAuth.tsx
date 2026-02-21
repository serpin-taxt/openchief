import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/lib/auth";

/**
 * Route guard that protects all dashboard routes.
 *
 * - "none" mode: everyone passes through.
 * - "cloudflare-access" mode: if the session check says unauthenticated
 *   (missing CF Access header), redirect to the CF Access login page so
 *   the user goes through the SSO flow. If no teamDomain is configured,
 *   show a helpful error instead.
 * - "password" mode: redirect to /login for the password form.
 */
export function RequireAuth() {
  const { checked, authenticated, provider, teamDomain } = useAuth();

  // Still loading session check — show nothing briefly
  if (!checked) {
    return null;
  }

  // "none" mode: everyone is authenticated
  if (provider === "none") {
    return <Outlet />;
  }

  // "cloudflare-access" mode
  if (provider === "cloudflare-access") {
    if (authenticated) {
      return <Outlet />;
    }

    // Not authenticated — redirect to CF Access login.
    // The Access login URL is: https://<teamDomain>/cdn-cgi/access/login?redirect_url=<current URL>
    if (teamDomain) {
      const loginUrl = `https://${teamDomain}/cdn-cgi/access/login?redirect_url=${encodeURIComponent(window.location.href)}`;
      window.location.href = loginUrl;
      return null;
    }

    // No teamDomain configured — show an error
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="max-w-md text-center space-y-4">
          <div className="mx-auto">
            <svg className="h-10 w-10 text-primary mx-auto" viewBox="6 12 52 42" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 44C10 44 18 50 32 50C46 50 54 44 54 44" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              <path d="M10 44L14 22L24 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M54 44L50 22L40 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M24 36L32 16L40 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-foreground">
            Cloudflare Access Not Configured
          </h1>
          <p className="text-sm text-muted-foreground">
            Authentication is set to Cloudflare Access but the team domain is
            missing. Set <code className="text-xs bg-muted px-1.5 py-0.5 rounded">CF_ACCESS_TEAM_DOMAIN</code> in
            your wrangler.jsonc vars or update <code className="text-xs bg-muted px-1.5 py-0.5 rounded">teamDomain</code> in
            your openchief.config.ts.
          </p>
        </div>
      </div>
    );
  }

  // "password" mode: redirect to login if not authenticated
  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
