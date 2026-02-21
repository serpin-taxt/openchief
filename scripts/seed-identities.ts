/**
 * Seed identity mappings into D1.
 *
 * Usage:
 *   npx tsx scripts/seed-identities.ts
 *
 * Reads identity mappings from agents/identity-mappings.json and upserts
 * them into the identity_mappings table in D1.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = join(__dirname, "../agents/identity-mappings.json");
const DB_NAME = "openchief-db";

function generateULID(): string {
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const now = Date.now();
  let time = "";
  let n = now;
  for (let i = 10; i > 0; i--) {
    const mod = n % 32;
    time = ENCODING[mod] + time;
    n = (n - mod) / 32;
  }
  let random = "";
  for (let i = 0; i < 16; i++) {
    random += ENCODING[Math.floor(Math.random() * 32)];
  }
  return time + random;
}

interface IdentitySeed {
  github_username?: string;
  slack_user_id?: string;
  email?: string;
  real_name: string;
  display_name?: string;
  figma_handle?: string;
  discord_handle?: string;
  team?: string;
  role?: string;
  is_bot: boolean;
}

const identities: IdentitySeed[] = JSON.parse(readFileSync(SEED_FILE, "utf-8"));
const now = new Date().toISOString();

for (const identity of identities) {
  const id = generateULID();
  const esc = (s: string | undefined | null) =>
    s ? `'${s.replace(/'/g, "''")}'` : "NULL";

  console.log(`Seeding identity: ${identity.github_username || identity.real_name}`);

  const sql = `INSERT OR REPLACE INTO identity_mappings (id, github_username, slack_user_id, email, real_name, display_name, figma_handle, discord_handle, team, role, avatar_url, is_bot, is_active, created_at, updated_at) VALUES ('${id}', ${esc(identity.github_username)}, ${esc(identity.slack_user_id)}, ${esc(identity.email)}, ${esc(identity.real_name)}, ${esc(identity.display_name)}, ${esc(identity.figma_handle)}, ${esc(identity.discord_handle)}, ${esc(identity.team)}, ${esc(identity.role)}, NULL, ${identity.is_bot ? 1 : 0}, 1, '${now}', '${now}');`;

  execSync(`npx wrangler d1 execute ${DB_NAME} --remote --command="${sql}"`, {
    stdio: "inherit",
  });

  console.log(`  Done`);
}

console.log(`\nSeeded ${identities.length} identity mappings.`);
