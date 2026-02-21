/**
 * Verify Intercom webhook signatures using HMAC-SHA256.
 *
 * Intercom signs webhook payloads using the client secret (hub secret).
 * The signature is sent in the `X-Hub-Signature` header as `sha1=<hex>`.
 *
 * Docs: https://developers.intercom.com/docs/webhooks
 */

export async function verifyIntercomSignature(
  body: string,
  signatureHeader: string | null,
  clientSecret: string
): Promise<boolean> {
  if (!signatureHeader || !clientSecret) return false;

  // Intercom sends "sha1=<hex_digest>"
  const parts = signatureHeader.split("=");
  if (parts.length !== 2 || parts[0] !== "sha1") return false;

  const receivedHex = parts[1];

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(clientSecret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );

  const expectedHex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (receivedHex.length !== expectedHex.length) return false;

  let mismatch = 0;
  for (let i = 0; i < receivedHex.length; i++) {
    mismatch |= receivedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return mismatch === 0;
}
