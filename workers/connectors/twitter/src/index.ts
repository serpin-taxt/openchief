/**
 * OpenChief X/Twitter Connector
 *
 * Polling-only connector that syncs tweets, mentions, and
 * engagement metrics from monitored X accounts.
 *
 * Endpoints:
 *   GET  /                -> health check
 *   POST /poll            -> manual poll (admin auth required)
 *   POST /backfill        -> full re-sync ignoring cursors (admin auth required)
 *   GET  /oauth/authorize -> start OAuth 2.0 PKCE flow for an X account
 *   GET  /oauth/callback  -> handle OAuth callback from X
 *   GET  /oauth/status    -> check which accounts have OAuth tokens
 *
 * Scheduled:
 *   Cron every 2 hours -> automatic poll
 *
 * Monitored accounts configured via X_MONITORED_ACCOUNTS env var.
 */

import { pollTwitter } from "./poll";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  getOAuthStatus,
} from "./oauth";

interface Env {
  EVENTS_QUEUE: Queue;
  KV: KVNamespace;
  DB: D1Database;
  X_BEARER_TOKEN: string;
  X_MONITORED_ACCOUNTS: string;
  X_SEARCH_QUERIES?: string;
  X_OAUTH_CLIENT_ID: string;
  X_OAUTH_CLIENT_SECRET: string;
  ADMIN_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // -- Health check ---------------------------------------------------------
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          service: "openchief-connector-twitter",
          status: "ok",
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // -- OAuth: Start authorization flow --------------------------------------
    if (url.pathname === "/oauth/authorize" && request.method === "GET") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Optional: ?account=myaccount to label which account
      const accountLabel = url.searchParams.get("account") ?? undefined;
      const redirectUri = `${url.origin}/oauth/callback`;

      try {
        const authUrl = await buildAuthorizationUrl(
          env.X_OAUTH_CLIENT_ID,
          redirectUri,
          env.KV,
          accountLabel
        );

        return new Response(
          JSON.stringify({
            ok: true,
            message: "Redirect the account owner to the authorization URL below",
            authorizationUrl: authUrl,
            account: accountLabel,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // -- OAuth: Callback from X -----------------------------------------------
    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        const description = url.searchParams.get("error_description") ?? error;
        return new Response(
          `<html><body><h2>Authorization Denied</h2><p>${escapeHtml(description)}</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      if (!code || !state) {
        return new Response(
          `<html><body><h2>Error</h2><p>Missing code or state parameter</p></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html" } }
        );
      }

      const redirectUri = `${url.origin}/oauth/callback`;

      try {
        const { tokens, accountLabel } = await exchangeCodeForTokens(
          code,
          state,
          env.X_OAUTH_CLIENT_ID,
          env.X_OAUTH_CLIENT_SECRET,
          redirectUri,
          env.KV
        );

        return new Response(
          `<html><body>
            <h2>Connected!</h2>
            <p>Successfully connected <strong>@${escapeHtml(tokens.username)}</strong> (${escapeHtml(tokens.userId)})</p>
            ${accountLabel ? `<p>Account label: ${escapeHtml(accountLabel)}</p>` : ""}
            <p>OAuth tokens stored. The connector will now use User Context for this account's mentions.</p>
            <p>You can close this window.</p>
          </body></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      } catch (err) {
        console.error("OAuth callback error:", err);
        return new Response(
          `<html><body>
            <h2>Authorization Failed</h2>
            <p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>
          </body></html>`,
          { status: 500, headers: { "Content-Type": "text/html" } }
        );
      }
    }

    // -- OAuth: Status check --------------------------------------------------
    if (url.pathname === "/oauth/status" && request.method === "GET") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const accounts = env.X_MONITORED_ACCOUNTS
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);

      const status = await getOAuthStatus(accounts, env.KV);

      return new Response(JSON.stringify({ ok: true, accounts: status }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // -- Manual poll ----------------------------------------------------------
    if (url.pathname === "/poll" && request.method === "POST") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        console.log("Poll starting, accounts:", env.X_MONITORED_ACCOUNTS);
        const result = await pollTwitter(env);
        console.log("Poll complete:", JSON.stringify(result));
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Manual poll failed:", err);
        return new Response(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // -- Backfill (full re-sync) ----------------------------------------------
    if (url.pathname === "/backfill" && request.method === "POST") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const result = await pollTwitter(env, { backfill: true });
        return new Response(
          JSON.stringify({ ok: true, backfill: true, result }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      } catch (err) {
        console.error("Backfill failed:", err);
        return new Response(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },

  // -- Scheduled polling ------------------------------------------------------
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      console.log("Twitter scheduled poll starting...");
      const result = await pollTwitter(env);
      console.log("Twitter scheduled poll complete:", JSON.stringify(result));
    } catch (err) {
      console.error("Twitter scheduled poll failed:", err);
    }
  },
};

// --- Helpers -----------------------------------------------------------------

function requireAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${env.ADMIN_SECRET}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
