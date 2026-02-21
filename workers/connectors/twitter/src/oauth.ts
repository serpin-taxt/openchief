/**
 * OAuth 2.0 Authorization Code Flow with PKCE for X/Twitter API v2.
 *
 * Handles authorization URL generation, token exchange, refresh,
 * and secure KV-backed token storage.
 *
 * Required scopes:
 *   tweet.read   -- read tweets and mentions
 *   users.read   -- read user profile info
 *   offline.access -- get refresh tokens (access tokens expire after 2h)
 *
 * Flow:
 *   1. GET /oauth/authorize -> redirect to X authorization page
 *   2. X redirects back to /oauth/callback?code=...&state=...
 *   3. Exchange code for access + refresh tokens
 *   4. Store tokens in KV, keyed by X user ID
 *   5. Poll uses stored access token; auto-refreshes when expired
 */

// --- KV Keys -----------------------------------------------------------------

const KV_PREFIX_OAUTH = "twitter:oauth:";
const KV_PREFIX_PKCE = "twitter:pkce:";

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (ms)
  scope: string;
  username: string;
  userId: string;
}

interface TokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token?: string;
  scope: string;
}

// --- PKCE Helpers ------------------------------------------------------------

/** Generate a cryptographically random code verifier (43-128 chars, URL-safe). */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Generate a code challenge from a verifier using S256. */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  const str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a random state parameter for CSRF protection. */
function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

// --- OAuth Scopes ------------------------------------------------------------

const OAUTH_SCOPES = [
  "tweet.read",
  "users.read",
  "offline.access",
].join(" ");

// --- Authorization -----------------------------------------------------------

/**
 * Build the X authorization URL and store PKCE verifier in KV.
 * Returns the URL to redirect the user to.
 */
export async function buildAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  kv: KVNamespace,
  /** Optional label to track which account this auth is for */
  accountLabel?: string
): Promise<string> {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Store verifier + metadata in KV (expires in 10 minutes)
  await kv.put(
    `${KV_PREFIX_PKCE}${state}`,
    JSON.stringify({ codeVerifier, accountLabel }),
    { expirationTtl: 600 }
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `https://x.com/i/oauth2/authorize?${params.toString()}`;
}

// --- Token Exchange ----------------------------------------------------------

/**
 * Exchange an authorization code for access + refresh tokens.
 * Stores the tokens in KV keyed by the authenticated user's ID.
 */
export async function exchangeCodeForTokens(
  code: string,
  state: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  kv: KVNamespace
): Promise<{ tokens: OAuthTokens; accountLabel?: string }> {
  // Retrieve and validate PKCE verifier
  const pkceKey = `${KV_PREFIX_PKCE}${state}`;
  const pkceRaw = await kv.get(pkceKey);
  if (!pkceRaw) {
    throw new Error("Invalid or expired OAuth state -- PKCE verifier not found");
  }

  const { codeVerifier, accountLabel } = JSON.parse(pkceRaw) as {
    codeVerifier: string;
    accountLabel?: string;
  };

  // Clean up PKCE state
  await kv.delete(pkceKey);

  // Exchange code for tokens -- use Basic auth if client secret available, otherwise public client flow
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const body: Record<string, string> = {
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };

  if (clientSecret) {
    headers["Authorization"] = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  } else {
    body["client_id"] = clientId;
  }

  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const tokenData = (await response.json()) as TokenResponse;

  if (!tokenData.refresh_token) {
    throw new Error("No refresh token returned -- ensure offline.access scope is granted");
  }

  // Look up who we just authenticated as
  const userInfo = await fetchAuthenticatedUser(tokenData.access_token);

  const tokens: OAuthTokens = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
    scope: tokenData.scope,
    username: userInfo.username,
    userId: userInfo.id,
  };

  // Store tokens in KV (no TTL -- we manage refresh ourselves)
  await kv.put(`${KV_PREFIX_OAUTH}${userInfo.id}`, JSON.stringify(tokens));

  // Also store a username -> userId mapping for easy lookup
  await kv.put(
    `${KV_PREFIX_OAUTH}username:${userInfo.username}`,
    userInfo.id,
    { expirationTtl: 30 * 24 * 60 * 60 } // 30 days
  );

  return { tokens, accountLabel };
}

// --- Token Refresh -----------------------------------------------------------

/**
 * Refresh an expired access token using the refresh token.
 * Updates the stored tokens in KV.
 */
export async function refreshAccessToken(
  userId: string,
  clientId: string,
  clientSecret: string,
  kv: KVNamespace
): Promise<OAuthTokens> {
  const tokenKey = `${KV_PREFIX_OAUTH}${userId}`;
  const raw = await kv.get(tokenKey);
  if (!raw) {
    throw new Error(`No OAuth tokens found for user ${userId}`);
  }

  const current = JSON.parse(raw) as OAuthTokens;

  // Use Basic auth if client secret available, otherwise public client flow
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
  };

  if (clientSecret) {
    headers["Authorization"] = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  } else {
    body["client_id"] = clientId;
  }

  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const tokenData = (await response.json()) as TokenResponse;

  const updated: OAuthTokens = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || current.refreshToken,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
    scope: tokenData.scope,
    username: current.username,
    userId: current.userId,
  };

  await kv.put(tokenKey, JSON.stringify(updated));
  return updated;
}

// --- Token Retrieval ---------------------------------------------------------

/**
 * Get a valid access token for a user, refreshing if necessary.
 * Returns null if no OAuth tokens are stored for this user.
 */
export async function getValidAccessToken(
  userId: string,
  clientId: string,
  clientSecret: string,
  kv: KVNamespace
): Promise<string | null> {
  const tokenKey = `${KV_PREFIX_OAUTH}${userId}`;
  const raw = await kv.get(tokenKey);
  if (!raw) return null;

  const tokens = JSON.parse(raw) as OAuthTokens;

  // Refresh 5 minutes before expiry to avoid edge cases
  if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
    try {
      const refreshed = await refreshAccessToken(userId, clientId, clientSecret, kv);
      return refreshed.accessToken;
    } catch (err) {
      console.error(`Failed to refresh token for ${userId}:`, err);
      return null;
    }
  }

  return tokens.accessToken;
}

/**
 * Resolve a username to an OAuth user ID via KV mapping.
 */
export async function resolveOAuthUserId(
  username: string,
  kv: KVNamespace
): Promise<string | null> {
  return kv.get(`${KV_PREFIX_OAUTH}username:${username}`);
}

/**
 * Get status of all OAuth-connected accounts.
 */
export async function getOAuthStatus(
  usernames: string[],
  kv: KVNamespace
): Promise<Array<{ username: string; connected: boolean; expiresAt?: number }>> {
  const results = [];
  for (const username of usernames) {
    const userId = await kv.get(`${KV_PREFIX_OAUTH}username:${username}`);
    if (!userId) {
      results.push({ username, connected: false });
      continue;
    }
    const raw = await kv.get(`${KV_PREFIX_OAUTH}${userId}`);
    if (!raw) {
      results.push({ username, connected: false });
      continue;
    }
    const tokens = JSON.parse(raw) as OAuthTokens;
    results.push({
      username,
      connected: true,
      expiresAt: tokens.expiresAt,
    });
  }
  return results;
}

// --- Internal Helpers --------------------------------------------------------

/** Fetch the authenticated user's info using their access token. */
async function fetchAuthenticatedUser(
  accessToken: string
): Promise<{ id: string; username: string; name: string }> {
  const response = await fetch("https://api.x.com/2/users/me?user.fields=id,name,username", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch authenticated user (${response.status}): ${text}`);
  }

  const body = (await response.json()) as { data: { id: string; username: string; name: string } };
  return body.data;
}
