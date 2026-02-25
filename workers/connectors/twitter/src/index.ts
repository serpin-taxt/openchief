/**
 * OpenChief X/Twitter Connector
 *
 * Polling-only connector that syncs tweets, mentions, and
 * engagement metrics from monitored X accounts.
 *
 * Endpoints:
 *   GET  /                   -> health check
 *   POST /poll               -> manual poll (admin auth required)
 *   POST /backfill           -> full re-sync ignoring cursors (admin auth required)
 *   GET  /oauth/authorize    -> start OAuth 2.0 PKCE flow for an X account
 *   GET  /oauth/callback     -> handle OAuth callback from X
 *   GET  /oauth/status       -> check which accounts have OAuth tokens
 *   GET  /accounts           -> list monitored accounts with OAuth status
 *   PUT  /accounts           -> update monitored accounts list
 *   GET  /search-queries     -> list search queries
 *   PUT  /search-queries     -> update search queries
 *   GET  /tweet/:id          -> fetch a single tweet by ID
 *
 * Scheduled:
 *   Cron every 2 hours -> automatic poll
 *
 * Monitored accounts configured via dashboard UI (KV) or X_MONITORED_ACCOUNTS env var.
 */

import { pollTwitter, getMonitoredAccounts } from "./poll";
import { TwitterClient } from "./twitter-client";
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
  WORKER_BASE_URL?: string;
}

/** Resolve the public-facing origin. When proxied via a service binding the
 *  Host header is the internal binding name (e.g. "connector"). Checks:
 *  1. WORKER_BASE_URL env var (most reliable for production)
 *  2. X-Forwarded-Host header (set by dashboard proxy)
 *  3. url.origin (direct access) */
function publicOrigin(request: Request, url: URL, baseUrl?: string): string {
  if (baseUrl) return baseUrl.replace(/\/$/, "");
  const forwarded = request.headers.get("X-Forwarded-Host");
  if (forwarded) return `https://${forwarded}`;
  return url.origin;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // -- Health check ---------------------------------------------------------
    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse({
        service: "openchief-connector-twitter",
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    // -- OAuth: Start authorization flow --------------------------------------
    if (url.pathname === "/oauth/authorize" && request.method === "GET") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Optional: ?account=myaccount to label which account
      const accountLabel = url.searchParams.get("account") ?? undefined;
      const redirectUri = `${publicOrigin(request, url, env.WORKER_BASE_URL)}/oauth/callback`;

      try {
        const authUrl = await buildAuthorizationUrl(
          env.X_OAUTH_CLIENT_ID,
          redirectUri,
          env.KV,
          accountLabel
        );

        return jsonResponse({
          ok: true,
          message: "Redirect the account owner to the authorization URL below",
          authorizationUrl: authUrl,
          account: accountLabel,
        });
      } catch (err) {
        return jsonResponse(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          500
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

      const accounts = await getMonitoredAccounts(env.KV, env.X_MONITORED_ACCOUNTS);
      const status = await getOAuthStatus(accounts, env.KV);

      return jsonResponse({ ok: true, accounts: status });
    }

    // -- Accounts: List monitored accounts with OAuth status ------------------
    if (url.pathname === "/accounts" && request.method === "GET") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const usernames = await getMonitoredAccounts(env.KV, env.X_MONITORED_ACCOUNTS);
        const oauthStatuses = await getOAuthStatus(usernames, env.KV);

        const accounts = oauthStatuses.map((s) => ({
          username: s.username,
          userId: null as string | null, // Could resolve via KV, but not critical for UI
          oauthConnected: s.connected,
          expiresAt: s.expiresAt ?? null,
        }));

        return jsonResponse({ ok: true, accounts });
      } catch (err) {
        return jsonResponse(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          500
        );
      }
    }

    // -- Accounts: Update monitored accounts list -----------------------------
    if (url.pathname === "/accounts" && request.method === "PUT") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const body = (await request.json()) as { accounts: string[] };
        if (!Array.isArray(body.accounts)) {
          return jsonResponse(
            { ok: false, error: "accounts must be an array of usernames" },
            400
          );
        }

        // Clean usernames: trim, remove @ prefix, lowercase
        const cleaned = body.accounts
          .map((a) => a.trim().replace(/^@/, "").toLowerCase())
          .filter(Boolean);

        if (cleaned.length > 0) {
          await env.KV.put(
            "twitter:config:monitored_accounts",
            cleaned.join(","),
            { expirationTtl: 365 * 24 * 60 * 60 } // 1 year
          );
        } else {
          await env.KV.delete("twitter:config:monitored_accounts");
        }

        return jsonResponse({ ok: true, accounts: cleaned });
      } catch (err) {
        return jsonResponse(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          500
        );
      }
    }

    // -- Search Queries: List ------------------------------------------------
    if (url.pathname === "/search-queries" && request.method === "GET") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const kvQueries = await env.KV.get("twitter:config:search_queries");
        const raw = kvQueries || env.X_SEARCH_QUERIES || "";
        const queries = raw
          .split("|")
          .map((q) => q.trim())
          .filter(Boolean);

        return jsonResponse({ ok: true, queries });
      } catch (err) {
        return jsonResponse(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          500
        );
      }
    }

    // -- Search Queries: Update ----------------------------------------------
    if (url.pathname === "/search-queries" && request.method === "PUT") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const body = (await request.json()) as { queries: string[] };
        if (!Array.isArray(body.queries)) {
          return jsonResponse(
            { ok: false, error: "queries must be an array of strings" },
            400
          );
        }

        const cleaned = body.queries.map((q) => q.trim()).filter(Boolean);

        if (cleaned.length > 0) {
          await env.KV.put(
            "twitter:config:search_queries",
            cleaned.join("|"),
            { expirationTtl: 365 * 24 * 60 * 60 }
          );
        } else {
          await env.KV.delete("twitter:config:search_queries");
        }

        return jsonResponse({ ok: true, queries: cleaned });
      } catch (err) {
        return jsonResponse(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          500
        );
      }
    }

    // -- Tweet: Fetch a single tweet by ID ------------------------------------
    const tweetMatch = url.pathname.match(/^\/tweet\/(\d+)$/);
    if (tweetMatch && request.method === "GET") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const tweetId = tweetMatch[1];
      try {
        const client = new TwitterClient(env.X_BEARER_TOKEN);
        const result = await client.getTweet(tweetId);

        if (!result) {
          return jsonResponse({ ok: false, error: "Tweet not found" }, 404);
        }

        const { tweet, users } = result;
        const author = users.find((u) => u.id === tweet.author_id);

        return jsonResponse({
          ok: true,
          tweet: {
            id: tweet.id,
            text: tweet.text,
            author_name: author?.name ?? "Unknown",
            author_username: author?.username ?? "unknown",
            url: `https://x.com/${author?.username ?? "i"}/status/${tweet.id}`,
            created_at: tweet.created_at,
            metrics: tweet.public_metrics ?? null,
          },
        });
      } catch (err) {
        return jsonResponse(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          500
        );
      }
    }

    // -- Manual poll ----------------------------------------------------------
    if (url.pathname === "/poll" && request.method === "POST") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const accounts = await getMonitoredAccounts(env.KV, env.X_MONITORED_ACCOUNTS);
        console.log("Poll starting, accounts:", accounts.join(","));
        const result = await pollTwitter(env);
        console.log("Poll complete:", JSON.stringify(result));
        return jsonResponse({ ok: true, result });
      } catch (err) {
        console.error("Manual poll failed:", err);
        return jsonResponse(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          500
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
        return jsonResponse({ ok: true, backfill: true, result });
      } catch (err) {
        console.error("Backfill failed:", err);
        return jsonResponse(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          500
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
