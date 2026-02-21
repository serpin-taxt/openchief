/**
 * Seed agent definitions into D1.
 *
 * Usage:
 *   pnpm seed
 *
 * Reads agent definition JSON files from agents/ and inserts them
 * into the D1 database using wrangler d1 execute.
 */

import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "../agents");
const DB_NAME = "openchief-db";
const WRANGLER_CONFIG = join(__dirname, "../workers/router/wrangler.jsonc");
const D1_MODE = process.env.OPENCHIEF_D1_MODE === "remote" ? "--remote" : "--local";

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

/** Escape a string for SQL single-quoted values */
function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

/** Execute SQL via a temp file to avoid shell escaping issues */
function execSQL(sql: string): void {
  const tmpFile = join(tmpdir(), `openchief-seed-${Date.now()}.sql`);
  try {
    writeFileSync(tmpFile, sql);
    execSync(
      `npx wrangler d1 execute ${DB_NAME} ${D1_MODE} -c "${WRANGLER_CONFIG}" --file="${tmpFile}"`,
      { stdio: "inherit" }
    );
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}

const agentFiles = process.env.OPENCHIEF_AGENT_FILES
  ? process.env.OPENCHIEF_AGENT_FILES.split(",")
  : readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".json") && f !== "identity-mappings.example.json");

console.log(`Found ${agentFiles.length} agent definitions in agents/\n`);

for (const file of agentFiles) {
  const agentPath = join(AGENTS_DIR, file);
  const agent = JSON.parse(readFileSync(agentPath, "utf-8"));
  const now = new Date().toISOString();

  console.log(`Seeding agent: ${agent.id} (${agent.name})`);

  // Build all SQL for this agent in one batch
  const statements: string[] = [];

  // Insert agent definition
  statements.push(
    `INSERT OR REPLACE INTO agent_definitions (id, name, description, config, enabled, created_at, updated_at) VALUES ('${sqlEscape(agent.id)}', '${sqlEscape(agent.name)}', '${sqlEscape(agent.description)}', '${sqlEscape(JSON.stringify(agent))}', ${agent.enabled ? 1 : 0}, '${now}', '${now}');`
  );

  // Insert subscriptions
  for (const sub of agent.subscriptions) {
    const subId = generateULID();
    statements.push(
      `INSERT OR REPLACE INTO agent_subscriptions (id, agent_id, source, event_types, scope_filter) VALUES ('${subId}', '${sqlEscape(agent.id)}', '${sqlEscape(sub.source)}', '${sqlEscape(JSON.stringify(sub.eventTypes))}', ${sub.scopeFilter ? `'${sqlEscape(JSON.stringify(sub.scopeFilter))}'` : "NULL"});`
    );
  }

  // Insert initial revision
  const revId = generateULID();
  statements.push(
    `INSERT OR REPLACE INTO agent_revisions (id, agent_id, config, changed_by, change_note, created_at) VALUES ('${revId}', '${sqlEscape(agent.id)}', '${sqlEscape(JSON.stringify(agent))}', 'seed-script', 'Initial seed', '${now}');`
  );

  execSQL(statements.join("\n"));
  console.log(`  ✓ Agent ${agent.id} seeded successfully`);
}

console.log(`\n✅ Done seeding ${agentFiles.length} agents.`);
