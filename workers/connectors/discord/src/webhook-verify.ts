/**
 * Verify Discord interaction signature (Ed25519).
 *
 * Discord sends:
 *   X-Signature-Ed25519: hex-encoded signature
 *   X-Signature-Timestamp: Unix timestamp string
 *
 * Signing message: timestamp + body
 */
export async function verifyDiscordSignature(
  body: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string
): Promise<boolean> {
  if (!signature || !timestamp) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToUint8Array(publicKey),
      { name: "Ed25519", namedCurve: "Ed25519" },
      false,
      ["verify"]
    );

    const encoder = new TextEncoder();
    const message = encoder.encode(timestamp + body);
    const sig = hexToUint8Array(signature);

    return await crypto.subtle.verify("Ed25519", key, sig, message);
  } catch (err) {
    console.error("Signature verification error:", err);
    return false;
  }
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
