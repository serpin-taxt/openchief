/**
 * OpenChief QuickBooks Online Connector
 *
 * Polls QuickBooks Online for financial data (invoices, payments, customers,
 * P&L reports) via Change Data Capture and Report APIs, normalizes them to
 * OpenChiefEvent format, and publishes to the openchief-events queue.
 *
 * Auth: OAuth 2.0 with stored refresh token.
 * One-time setup via /oauth/start -> Intuit consent -> /oauth/callback.
 */

import { runPollTasks } from "./poll";

export interface Env {
  EVENTS_QUEUE: Queue;
  QB_CLIENT_ID: string;
  QB_CLIENT_SECRET: string;
  ADMIN_SECRET: string;
  KV: KVNamespace;
}

const SCOPES = "com.intuit.quickbooks.accounting";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireAdmin(request: Request, env: Env): Response | null {
  const auth = request.headers.get("Authorization");
  if (!env.ADMIN_SECRET || auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      const hasRefreshToken = !!(await env.KV.get("qb:refresh_token"));
      const realmId = await env.KV.get("qb:realm_id");
      return jsonResponse({
        service: "openchief-connector-quickbooks",
        status: "ok",
        oauthConnected: hasRefreshToken,
        realmId: realmId || null,
        lastPoll: (await env.KV.get("qb:cursor")) || null,
      });
    }

    // GET /oauth/start -- redirect to Intuit OAuth consent screen
    if (url.pathname === "/oauth/start" && request.method === "GET") {
      const redirectUri = `${url.origin}/oauth/callback`;
      const params = new URLSearchParams({
        client_id: env.QB_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES,
        state: "openchief",
      });
      return Response.redirect(
        `https://appcenter.intuit.com/connect/oauth2?${params}`,
        302
      );
    }

    // GET /oauth/callback -- exchange authorization code for tokens
    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const realmId = url.searchParams.get("realmId");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(
          `<html><body><h1>OAuth Error</h1><p>${error}</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      if (!code || state !== "openchief") {
        return new Response("Missing code or invalid state", { status: 400 });
      }

      const redirectUri = `${url.origin}/oauth/callback`;

      // QuickBooks requires Basic auth header for token exchange
      const credentials = btoa(`${env.QB_CLIENT_ID}:${env.QB_CLIENT_SECRET}`);

      const tokenResp = await fetch(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${credentials}`,
            Accept: "application/json",
          },
          body: new URLSearchParams({
            code,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
          }),
        }
      );

      const tokenData = (await tokenResp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        x_refresh_token_expires_in?: number;
        error?: string;
        error_description?: string;
      };

      if (!tokenResp.ok || !tokenData.access_token) {
        return new Response(
          `<html><body><h1>Token Exchange Failed</h1><pre>${JSON.stringify(tokenData, null, 2)}</pre></body></html>`,
          { status: 500, headers: { "Content-Type": "text/html" } }
        );
      }

      // Store access token with TTL (slightly shorter than actual expiry)
      const ttl = Math.max((tokenData.expires_in || 3600) - 300, 60);
      await env.KV.put("qb:access_token", tokenData.access_token, {
        expirationTtl: ttl,
      });

      // Store refresh token (long-lived, ~100 days)
      if (tokenData.refresh_token) {
        await env.KV.put("qb:refresh_token", tokenData.refresh_token);
      }

      // Store realm ID (company ID) -- needed for all API calls
      if (realmId) {
        await env.KV.put("qb:realm_id", realmId);
      }

      return new Response(
        `<html><body>
          <h1>QuickBooks Connected!</h1>
          <p>Access token stored (expires in ${tokenData.expires_in}s).</p>
          <p>Refresh token: ${tokenData.refresh_token ? "stored" : "not provided"}</p>
          <p>Realm ID: ${realmId || "not provided"}</p>
          <p>You can close this tab.</p>
        </body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    // POST /poll -- manual poll trigger (admin only)
    if (url.pathname === "/poll" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const result = await runPollTasks(env);
        return jsonResponse({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Poll failed";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // POST /backfill -- re-poll with extended lookback (admin only)
    if (url.pathname === "/backfill" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const days = Number(url.searchParams.get("days") || "30");
        const result = await runPollTasks(env, days);
        return jsonResponse({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Backfill failed";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ) {
    try {
      const result = await runPollTasks(env);
      console.log("QuickBooks poll complete:", JSON.stringify(result));
    } catch (err) {
      console.error(
        "QuickBooks poll failed:",
        err instanceof Error ? err.message : err
      );
    }
  },
};
