const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, len: number): string {
  let str = "";
  for (let i = len; i > 0; i--) {
    const mod = now % ENCODING.length;
    str = ENCODING[mod] + str;
    now = (now - mod) / ENCODING.length;
  }
  return str;
}

function encodeRandom(len: number): string {
  let str = "";
  const randomBytes = new Uint8Array(len);
  crypto.getRandomValues(randomBytes);
  for (let i = 0; i < len; i++) {
    str += ENCODING[randomBytes[i] % ENCODING.length];
  }
  return str;
}

/**
 * Generate a ULID — lexicographically sortable unique ID.
 * Format: 10 time chars + 16 random chars = 26 total.
 */
export function generateULID(): string {
  const timestamp = encodeTime(Date.now(), 10);
  const randomness = encodeRandom(16);
  return timestamp + randomness;
}
