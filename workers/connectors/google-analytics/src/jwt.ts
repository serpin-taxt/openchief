/**
 * Google Service Account JWT authentication for Cloudflare Workers.
 * Uses WebCrypto API (PKCS#8 format) for RS256 JWT signing.
 *
 * Flow:
 *   1. Parse the service account JSON key
 *   2. Generate a JWT signed with the private key
 *   3. Exchange the JWT for an access token (valid 1 hour)
 *   4. Cache the token and refresh when it's about to expire
 */

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id: string;
}

interface CachedToken {
  token: string;
  expiresAt: number; // Unix ms
}

// Module-level cache — persists within a single Worker isolate's lifetime.
let cachedAccessToken: CachedToken | null = null;

/**
 * Get a valid access token for the Google Analytics Data API.
 * Tokens are valid for 1 hour; we refresh with a 5-minute buffer.
 */
export async function getAccessToken(serviceAccountKeyJson: string): Promise<string> {
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000;

  if (cachedAccessToken && cachedAccessToken.expiresAt - bufferMs > now) {
    return cachedAccessToken.token;
  }

  const key = parseServiceAccountKey(serviceAccountKeyJson);
  const jwt = await generateJWT(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };

  cachedAccessToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return cachedAccessToken.token;
}

/**
 * Parse the service account JSON key.
 * Accepts either raw JSON or base64-encoded JSON.
 */
function parseServiceAccountKey(input: string): ServiceAccountKey {
  let json = input;

  // Try base64 decode first
  try {
    const decoded = atob(input);
    if (decoded.includes('"client_email"')) {
      json = decoded;
    }
  } catch {
    // Not base64, use raw
  }

  const parsed = JSON.parse(json);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Invalid service account key: missing client_email or private_key");
  }
  return parsed as ServiceAccountKey;
}

/**
 * Generate a JWT for Google OAuth2 service account authentication.
 */
async function generateJWT(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600, // 1 hour
  };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await importPrivateKey(key.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
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
