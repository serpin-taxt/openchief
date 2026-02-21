/**
 * Read openchief.config.ts and update all wrangler.jsonc files
 * with the correct Cloudflare resource IDs.
 *
 * Usage: npx tsx scripts/generate-config.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface WranglerConfig {
  name: string;
  account_id?: string;
  [key: string]: unknown;
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id: string;
  }>;
  kv_namespaces?: Array<{
    binding: string;
    id: string;
  }>;
  queues?: {
    consumers?: Array<{ queue: string; [key: string]: unknown }>;
    producers?: Array<{ queue: string; binding: string }>;
  };
  vars?: Record<string, string>;
}

// ── Worker definitions: what each worker needs ──────────────────────────

interface WorkerSpec {
  /** Path relative to project root */
  path: string;
  /** Whether this worker needs D1 binding */
  needsD1: boolean;
  /** KV binding names this worker uses */
  kvBindings: string[];
  /** Whether it needs account_id set as a var */
  needsAccountVar: boolean;
  /** Whether this worker needs Vectorize + AI bindings (for RAG) */
  needsVectorize?: boolean;
  /** Connector name (for connectors only) */
  connectorName?: string;
}

const WORKERS: WorkerSpec[] = [
  {
    path: "workers/runtime",
    needsD1: true,
    kvBindings: ["KV"],
    needsAccountVar: false,
    needsVectorize: true,
  },
  {
    path: "workers/router",
    needsD1: true,
    kvBindings: ["KV"],
    needsAccountVar: false,
  },
  {
    path: "workers/dashboard",
    needsD1: true,
    kvBindings: ["KV"],
    needsAccountVar: true,
  },
  {
    path: "workers/connectors/github",
    needsD1: false,
    kvBindings: ["POLL_CURSOR"],
    needsAccountVar: false,
    connectorName: "github",
  },
  {
    path: "workers/connectors/slack",
    needsD1: true,
    kvBindings: ["KV"],
    needsAccountVar: false,
    connectorName: "slack",
  },
  {
    path: "workers/connectors/discord",
    needsD1: true,
    kvBindings: ["KV"],
    needsAccountVar: false,
    connectorName: "discord",
  },
  {
    path: "workers/connectors/jira",
    needsD1: false,
    kvBindings: ["POLL_CURSOR"],
    needsAccountVar: false,
    connectorName: "jira",
  },
  {
    path: "workers/connectors/notion",
    needsD1: false,
    kvBindings: ["POLL_CURSOR"],
    needsAccountVar: false,
    connectorName: "notion",
  },
  {
    path: "workers/connectors/figma",
    needsD1: true,
    kvBindings: ["KV"],
    needsAccountVar: false,
    connectorName: "figma",
  },
  {
    path: "workers/connectors/intercom",
    needsD1: true,
    kvBindings: ["KV"],
    needsAccountVar: false,
    connectorName: "intercom",
  },
  {
    path: "workers/connectors/twitter",
    needsD1: true,
    kvBindings: ["KV"],
    needsAccountVar: false,
    connectorName: "twitter",
  },
  {
    path: "workers/connectors/amplitude",
    needsD1: true,
    kvBindings: ["KV"],
    needsAccountVar: false,
    connectorName: "amplitude",
  },
  {
    path: "workers/connectors/google-calendar",
    needsD1: false,
    kvBindings: ["KV"],
    needsAccountVar: false,
    connectorName: "google-calendar",
  },
  {
    path: "workers/connectors/google-analytics",
    needsD1: false,
    kvBindings: ["KV"],
    needsAccountVar: false,
    connectorName: "google-analytics",
  },
  {
    path: "workers/connectors/quickbooks",
    needsD1: false,
    kvBindings: ["KV"],
    needsAccountVar: false,
    connectorName: "quickbooks",
  },
  {
    path: "workers/connectors/jpd",
    needsD1: false,
    kvBindings: ["POLL_CURSOR"],
    needsAccountVar: false,
    connectorName: "jpd",
  },
  {
    path: "workers/connectors/rippling",
    needsD1: true,
    kvBindings: ["KV"],
    needsAccountVar: false,
    connectorName: "rippling",
  },
  // Demo engine -- only included in generate-config, deployed separately
  {
    path: "workers/demo-engine",
    needsD1: false,
    kvBindings: [],
    needsAccountVar: false,
  },
];

async function main() {
  // Load the config file
  const configPath = resolve(ROOT, "openchief.config.ts");
  if (!existsSync(configPath)) {
    console.error("❌ openchief.config.ts not found.");
    console.error("   Copy openchief.example.config.ts → openchief.config.ts and fill in your values.");
    process.exit(1);
  }

  // Dynamic import of the TS config
  const configModule = await import(configPath);
  const config = configModule.default;

  if (!config?.cloudflare?.accountId) {
    console.error("❌ cloudflare.accountId is required in openchief.config.ts");
    process.exit(1);
  }

  const { accountId, d1DatabaseId, kvNamespaceId, queueName, vectorizeIndexName } = config.cloudflare;
  const isLocalMode = accountId === "local" || d1DatabaseId === "local-placeholder";

  if (!isLocalMode) {
    if (!d1DatabaseId || d1DatabaseId === "") {
      console.error("❌ cloudflare.d1DatabaseId is required. Run `pnpm run setup` to create resources.");
      process.exit(1);
    }
    if (!kvNamespaceId || kvNamespaceId === "") {
      console.error("❌ cloudflare.kvNamespaceId is required. Run `pnpm run setup` to create resources.");
      process.exit(1);
    }
  }

  console.log("📋 OpenChief Config Generator");
  if (isLocalMode) {
    console.log("   Mode:    local development");
  } else {
    console.log(`   Account: ${accountId}`);
  }
  console.log(`   D1:      ${d1DatabaseId}`);
  console.log(`   KV:      ${kvNamespaceId}`);
  console.log(`   Queue:   ${queueName || "openchief-events"}`);
  console.log(`   RAG:     ${vectorizeIndexName || "(disabled)"}`);
  console.log();

  let updated = 0;

  for (const worker of WORKERS) {
    // Skip connectors that aren't enabled
    if (worker.connectorName) {
      const connConfig = config.connectors?.[worker.connectorName];
      if (!connConfig?.enabled) {
        console.log(`   ⏭  ${worker.path} (connector disabled)`);
        continue;
      }
    }

    const wranglerPath = join(ROOT, worker.path, "wrangler.jsonc");
    if (!existsSync(wranglerPath)) {
      console.log(`   ⚠️  ${worker.path}/wrangler.jsonc not found, skipping`);
      continue;
    }

    let content = readFileSync(wranglerPath, "utf-8");

    // Replace placeholder D1 database ID
    if (worker.needsD1) {
      content = content.replace(
        /("database_id"\s*:\s*)"[^"]*"/g,
        `$1"${d1DatabaseId}"`
      );
    }

    // Replace placeholder KV namespace ID
    for (const _binding of worker.kvBindings) {
      content = content.replace(
        /("id"\s*:\s*)"REPLACE_WITH_KV_NAMESPACE_ID"/g,
        `$1"${kvNamespaceId}"`
      );
    }

    // Replace queue name if custom
    if (queueName && queueName !== "openchief-events") {
      content = content.replace(
        /"openchief-events"/g,
        `"${queueName}"`
      );
    }

    // Add or update account_id (skip for local mode — wrangler dev doesn't need it)
    if (!isLocalMode) {
      if (content.includes('"account_id"')) {
        // Already has account_id — update it
        content = content.replace(
          /("account_id"\s*:\s*)"[^"]*"/,
          `$1"${accountId}"`
        );
      } else if (content.includes("// account_id")) {
        // Has a commented-out account_id — replace the comment line
        content = content.replace(
          /\/\/\s*account_id:.*\n/,
          `"account_id": "${accountId}",\n`
        );
      } else {
        // Insert after "name" line
        content = content.replace(
          /("name"\s*:\s*"[^"]*")(,?\s*\n)/,
          `$1,\n  "account_id": "${accountId}"$2`
        );
      }

      // Add CF_ACCOUNT_ID var if needed
      if (worker.needsAccountVar) {
        content = content.replace(
          /"CF_ACCOUNT_ID"\s*:\s*"[^"]*"/,
          `"CF_ACCOUNT_ID": "${accountId}"`
        );
      }

      // Set AUTH_PROVIDER var for dashboard
      if (worker.path === "workers/dashboard" && config.auth?.provider) {
        content = content.replace(
          /"AUTH_PROVIDER"\s*:\s*"[^"]*"/,
          `"AUTH_PROVIDER": "${config.auth.provider}"`
        );

        // Set CF_ACCESS_TEAM_DOMAIN var when using Cloudflare Access
        if (config.auth.provider === "cloudflare-access" && config.auth.teamDomain) {
          if (content.includes('"CF_ACCESS_TEAM_DOMAIN"')) {
            content = content.replace(
              /"CF_ACCESS_TEAM_DOMAIN"\s*:\s*"[^"]*"/,
              `"CF_ACCESS_TEAM_DOMAIN": "${config.auth.teamDomain}"`
            );
          } else {
            // Insert after AUTH_PROVIDER line
            content = content.replace(
              /("AUTH_PROVIDER"\s*:\s*"[^"]*")/,
              `$1,\n    "CF_ACCESS_TEAM_DOMAIN": "${config.auth.teamDomain}"`
            );
          }
        }
      }
    }

    // Set runtime worker vars (org info, model, timezone, GitHub repo)
    if (worker.path === "workers/runtime") {
      const runtimeVars: Record<string, string> = {
        ORG_NAME: config.instance?.orgName || "My Company",
        ORG_CONTEXT: config.instance?.context || "",
        DEFAULT_MODEL: config.runtime?.defaultModel || "claude-sonnet-4-6",
        REPORT_TIMEZONE: config.runtime?.reportTimezone || "UTC",
        GITHUB_REPO: config.github?.repo || "",
      };

      for (const [key, value] of Object.entries(runtimeVars)) {
        const pattern = new RegExp(`"${key}"\\s*:\\s*"[^"]*"`);
        if (pattern.test(content)) {
          content = content.replace(pattern, `"${key}": ${JSON.stringify(value)}`);
        }
      }

      // Update cron schedule from reportTimeUtcHour
      const reportHour = config.runtime?.reportTimeUtcHour;
      if (reportHour !== undefined && reportHour !== null) {
        // Generate cron: 55 minutes before the hour (to allow processing time)
        // e.g. hour=14 → "55 13 * * 1-5" (reports ready by 14:00)
        const cronHour = reportHour === 0 ? 23 : reportHour - 1;
        content = content.replace(
          /"crons"\s*:\s*\["[^"]*"\]/,
          `"crons": ["55 ${cronHour} * * 1-5"]`
        );
      }
    }

    // Add Vectorize + AI bindings for RAG (runtime worker only)
    if (worker.needsVectorize && vectorizeIndexName) {
      // Add or update vectorize binding
      if (content.includes('"vectorize"')) {
        // Already has vectorize — update index name
        content = content.replace(
          /("index_name"\s*:\s*)"[^"]*"/,
          `$1"${vectorizeIndexName}"`
        );
      } else {
        // Insert vectorize and ai bindings before the closing brace
        const vectorizeBlock = `\n  "vectorize": [\n    {\n      "binding": "VECTORIZE",\n      "index_name": "${vectorizeIndexName}"\n    }\n  ],\n  "ai": {\n    "binding": "AI"\n  }`;
        // Insert before the last closing brace
        const lastBrace = content.lastIndexOf("}");
        content = content.slice(0, lastBrace) + "," + vectorizeBlock + "\n" + content.slice(lastBrace);
      }

      // Add ai binding if not present (may already exist from vectorize block above)
      if (!content.includes('"ai"')) {
        const aiBlock = `\n  "ai": {\n    "binding": "AI"\n  }`;
        const lastBrace = content.lastIndexOf("}");
        content = content.slice(0, lastBrace) + "," + aiBlock + "\n" + content.slice(lastBrace);
      }
    }

    writeFileSync(wranglerPath, content);
    console.log(`   ✅ ${worker.path}/wrangler.jsonc`);
    updated++;
  }

  console.log();
  console.log(`✅ Updated ${updated} wrangler.jsonc files.`);
  console.log();
  if (isLocalMode) {
    console.log("Next steps:");
    console.log("  1. Seed agents: pnpm seed");
    console.log("  2. Start dev: pnpm dev");
  } else {
    console.log("Next steps:");
    console.log("  1. Set secrets: wrangler secret put ANTHROPIC_API_KEY -c workers/runtime/wrangler.jsonc");
    console.log("  2. Run migrations: wrangler d1 migrations apply openchief-db --remote");
    console.log("  3. Seed agents: pnpm seed");
    console.log("  4. Deploy: pnpm build && deploy each worker");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
