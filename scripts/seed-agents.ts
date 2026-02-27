/**
 * Seed agent definitions into D1.
 *
 * Usage:
 *   pnpm seed            # auto-detects --local vs --remote from config
 *   pnpm seed --local    # force local D1
 *   pnpm seed --remote   # force remote D1
 *
 * Reads agent definition JSON files from agents/ and inserts them
 * into the D1 database using wrangler d1 execute.
 *
 * Detection logic (when no flag is passed):
 *   - If OPENCHIEF_D1_MODE env var is set, uses that
 *   - If openchief.config.ts exists and has a real accountId (not "local"),
 *     defaults to --remote
 *   - Otherwise defaults to --local
 */

import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { OpenChiefConfig } from "@openchief/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "../agents");
const DB_NAME = "openchief-db";
const WRANGLER_CONFIG = join(__dirname, "../workers/router/wrangler.jsonc");

/** Load openchief.config.ts if it exists (deployment-specific overrides) */
async function loadConfig(): Promise<OpenChiefConfig | null> {
  const configPath = join(__dirname, "../openchief.config.ts");
  if (!existsSync(configPath)) return null;
  try {
    const mod = await import(pathToFileURL(configPath).href);
    return (mod.default ?? mod) as OpenChiefConfig;
  } catch (err) {
    console.warn(`⚠ Could not load openchief.config.ts: ${err}`);
    return null;
  }
}

/**
 * Resolve D1 mode (--local or --remote).
 *
 * Priority:
 *   1. Explicit CLI flag: --local or --remote
 *   2. OPENCHIEF_D1_MODE env var
 *   3. Auto-detect from openchief.config.ts (real accountId → remote)
 *   4. Default to --local
 */
function resolveD1Mode(config: OpenChiefConfig | null): string {
  // 1. Explicit CLI flags
  if (process.argv.includes("--remote")) return "--remote";
  if (process.argv.includes("--local")) return "--local";

  // 2. Env var (set by setup.ts)
  if (process.env.OPENCHIEF_D1_MODE === "remote") return "--remote";
  if (process.env.OPENCHIEF_D1_MODE === "local") return "--local";

  // 3. Auto-detect from config — if there's a real Cloudflare account ID,
  //    the user has deployed and almost certainly wants --remote
  const accountId = config?.cloudflare?.accountId;
  if (accountId && accountId !== "local" && accountId !== "local-placeholder") {
    return "--remote";
  }

  // 4. Fallback
  return "--local";
}

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
function execSQL(sql: string, d1Mode: string): void {
  const tmpFile = join(tmpdir(), `openchief-seed-${Date.now()}.sql`);
  try {
    writeFileSync(tmpFile, sql);
    execSync(
      `npx wrangler d1 execute ${DB_NAME} ${d1Mode} -c "${WRANGLER_CONFIG}" --file="${tmpFile}"`,
      { stdio: "inherit" }
    );
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}

const agentFiles = process.env.OPENCHIEF_AGENT_FILES
  ? process.env.OPENCHIEF_AGENT_FILES.split(",")
  : readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".json") && f !== "identity-mappings.example.json");

// Load deployment-specific config for channel filter overrides
const config = await loadConfig();
const channelFilters = config?.agents?.channelFilters ?? {};
if (Object.keys(channelFilters).length > 0) {
  console.log(`Loaded channel filters for: ${Object.keys(channelFilters).join(", ")}`);
}

// Resolve D1 mode — auto-detects from config when no explicit flag is passed
const D1_MODE = resolveD1Mode(config);
console.log(`D1 mode: ${D1_MODE === "--remote" ? "remote" : "local"}${
  process.argv.includes("--remote") || process.argv.includes("--local")
    ? " (explicit)"
    : process.env.OPENCHIEF_D1_MODE
    ? " (from OPENCHIEF_D1_MODE env)"
    : config?.cloudflare?.accountId && config.cloudflare.accountId !== "local"
    ? " (auto-detected from config)"
    : " (default)"
}`);

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

  // Insert subscriptions — merge channel filters from config if present
  const agentChannels = channelFilters[agent.id];
  for (const sub of agent.subscriptions) {
    const subId = generateULID();

    // Merge deployment-specific channel filters into Slack subscriptions
    let scopeFilter = sub.scopeFilter ?? null;
    if (agentChannels && (sub.source === "slack" || sub.source === "discord")) {
      scopeFilter = { ...scopeFilter, project: agentChannels };
      console.log(`  → Applied channel filter to ${sub.source}: ${agentChannels.join(", ")}`);
    }

    statements.push(
      `INSERT OR REPLACE INTO agent_subscriptions (id, agent_id, source, event_types, scope_filter) VALUES ('${subId}', '${sqlEscape(agent.id)}', '${sqlEscape(sub.source)}', '${sqlEscape(JSON.stringify(sub.eventTypes))}', ${scopeFilter ? `'${sqlEscape(JSON.stringify(scopeFilter))}'` : "NULL"});`
    );
  }

  // Insert initial revision
  const revId = generateULID();
  statements.push(
    `INSERT OR REPLACE INTO agent_revisions (id, agent_id, config, changed_by, change_note, created_at) VALUES ('${revId}', '${sqlEscape(agent.id)}', '${sqlEscape(JSON.stringify(agent))}', 'seed-script', 'Initial seed', '${now}');`
  );

  execSQL(statements.join("\n"), D1_MODE);
  console.log(`  ✓ Agent ${agent.id} seeded successfully`);
}

console.log(`\n✅ Done seeding ${agentFiles.length} agents.`);
