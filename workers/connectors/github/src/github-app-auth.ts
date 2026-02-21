/**
 * GitHub App authentication for Cloudflare Workers.
 * Uses WebCrypto API (PKCS#8 format) for RS256 JWT signing.
 *
 * Flow:
 *   1. Generate a short-lived JWT signed with the app's private key
 *   2. Exchange the JWT for an installation access token (valid 1 hour)
 *   3. Cache the token and refresh when it's about to expire
 */

export interface GitHubAppEnv {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
}

interface CachedToken {
  token: string;
  expiresAt: number; // Unix ms
}

// Module-level cache -- persists within a single Worker isolate's lifetime.
let cachedInstallationToken: CachedToken | null = null;

/**
 * Get a valid installation access token, refreshing if expired.
 * Tokens are valid for 1 hour; we refresh with a 5-minute buffer.
 */
export async function getInstallationToken(env: GitHubAppEnv): Promise<string> {
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000;

  if (cachedInstallationToken && cachedInstallationToken.expiresAt - bufferMs > now) {
    return cachedInstallationToken.token;
  }

  const jwt = await generateJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const res = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "openchief-connector-github",
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get installation token: ${res.status} ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };

  cachedInstallationToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };

  return cachedInstallationToken.token;
}

/**
 * Generate a JWT signed with the GitHub App's private key (RS256).
 * The key must be in PKCS#8 PEM format.
 *
 * If you have a PKCS#1 key (BEGIN RSA PRIVATE KEY), convert it:
 *   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem
 */
async function generateJWT(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60, // issued 60s ago (clock skew tolerance)
    exp: now + 10 * 60, // expires in 10 minutes (GitHub max)
    iss: appId,
  };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64urlEncode(signature)}`;
}

/**
 * Import a PEM private key for use with WebCrypto.
 * Supports PKCS#8 format (BEGIN PRIVATE KEY).
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/**
 * Base64url encode (no padding, URL-safe).
 */
function base64urlEncode(input: string | ArrayBuffer): string {
  let base64: string;
  if (typeof input === "string") {
    base64 = btoa(input);
  } else {
    base64 = btoa(String.fromCharCode(...new Uint8Array(input)));
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
