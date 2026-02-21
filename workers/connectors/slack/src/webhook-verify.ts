/**
 * Verify Slack request signature (HMAC SHA-256).
 *
 * Slack sends:
 *   X-Slack-Request-Timestamp: Unix seconds
 *   X-Slack-Signature: v0=<hex_hmac_sha256>
 *
 * Signing string: "v0:{timestamp}:{rawBody}"
 * Replay protection: rejects requests older than 5 minutes.
 */
export async function verifySlackSignature(
  body: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string
): Promise<boolean> {
  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const sigBaseString = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(sigBaseString)
  );
  const expected = `v0=${arrayBufferToHex(sig)}`;

  return timingSafeEqual(expected, signature);
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
