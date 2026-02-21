#!/usr/bin/env npx tsx
/**
 * Tear down all OpenChief workers and Cloudflare resources.
 *
 * Reads openchief.config.ts for resource IDs, then deletes everything
 * in the correct order (workers first, then resources).
 *
 * Usage:
 *   pnpm run teardown              # Interactive (two confirmation prompts)
 *   pnpm run teardown --yes        # Skip prompts (for CI / scripting)
 *   pnpm run teardown --keep-config # Don't delete openchief.config.ts
 */

import { createInterface } from "readline";
import { existsSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const YES = process.argv.includes("--yes");
const KEEP_CONFIG = process.argv.includes("--keep-config");

// ── ANSI colors ─────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  orange: "\x1b[38;5;208m",
  amber: "\x1b[38;5;214m",
  yellow: "\x1b[38;5;220m",
  green: "\x1b[38;5;114m",
  cyan: "\x1b[38;5;117m",
  gray: "\x1b[38;5;243m",
  white: "\x1b[38;5;255m",
};

// ── Readline helpers ────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    rl.question(`  ${question} ${hint}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

// ── Command runner ──────────────────────────────────────────────

function run(cmd: string): { success: boolean; output: string } {
  console.log(`  ${c.dim}→${c.reset} ${cmd}`);
  try {
    const output = execSync(cmd, { cwd: ROOT, encoding: "utf-8", stdio: "pipe" });
    if (output.trim()) {
      for (const line of output.trim().split("\n")) {
        console.log(`  ${c.dim}${line}${c.reset}`);
      }
    }
    return { success: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    if (e.stderr) console.log(`  ${c.yellow}${e.stderr.trim()}${c.reset}`);
    return { success: false, output: e.stdout || "" };
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log(`  ${c.orange}              /\\${c.reset}`);
  console.log(`  ${c.orange}       /\\    /  \\    /\\${c.reset}`);
  console.log(`  ${c.amber}      /  \\  /    \\  /  \\${c.reset}`);
  console.log(`  ${c.amber}     /    \\/      \\/    \\${c.reset}`);
  console.log(`  ${c.yellow}     \\                   /${c.reset}`);
  console.log(`  ${c.yellow}      \`-----------------'${c.reset}`);
  console.log("");
  console.log(`  ${c.bold}${c.white}     O p e n C h i e f${c.reset}  ${c.dim}teardown${c.reset}`);
  console.log("");

  // ── Load config ───────────────────────────────────────────────

  const configPath = resolve(ROOT, "openchief.config.ts");
  if (!existsSync(configPath)) {
    console.error(`  ${c.orange}✗${c.reset} openchief.config.ts not found. Nothing to tear down.`);
    rl.close();
    process.exit(1);
  }

  let config: any;
  try {
    const configModule = await import(configPath);
    config = configModule.default;
  } catch (err) {
    console.error(`  ${c.orange}✗${c.reset} Failed to load config: ${(err as Error).message}`);
    rl.close();
    process.exit(1);
  }

  const accountId = config.cloudflare?.accountId;
  if (accountId && accountId !== "local") {
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }

  const isLocal = accountId === "local" || config.cloudflare?.d1DatabaseId === "local-placeholder";

  // ── Collect what will be deleted ──────────────────────────────

  const enabledConnectors = Object.entries(config.connectors || {})
    .filter(([, v]: [string, any]) => v.enabled)
    .map(([k]) => k);

  const connectorWorkers = enabledConnectors.map((s) => `openchief-connector-${s}`);
  const coreWorkers = ["openchief-dashboard", "openchief-router", "openchief-runtime"];
  const allWorkers = [...connectorWorkers, ...coreWorkers];

  const kvId = config.cloudflare?.kvNamespaceId;
  const d1Id = config.cloudflare?.d1DatabaseId;
  const queueName = config.cloudflare?.queueName || "openchief-events";
  const vectorizeName = config.cloudflare?.vectorizeIndexName;

  // ── Show what will be deleted ─────────────────────────────────

  console.log(`  ${c.yellow}⚠${c.reset}  This will ${c.bold}permanently delete${c.reset}:\n`);

  for (const w of allWorkers) {
    console.log(`     ${c.dim}•${c.reset} Worker: ${c.white}${w}${c.reset}`);
  }

  if (!isLocal) {
    console.log(`     ${c.dim}•${c.reset} Queue:  ${c.white}${queueName}${c.reset}`);
    if (vectorizeName) {
      console.log(`     ${c.dim}•${c.reset} Vectorize: ${c.white}${vectorizeName}${c.reset}`);
    }
    console.log(`     ${c.dim}•${c.reset} KV:    ${c.white}${kvId}${c.reset}`);
    console.log(`     ${c.dim}•${c.reset} D1:    ${c.white}openchief-db${c.reset} ${c.dim}(${d1Id})${c.reset}`);
  }

  if (!KEEP_CONFIG) {
    console.log(`     ${c.dim}•${c.reset} Config: ${c.white}openchief.config.ts${c.reset}`);
  }

  console.log("");

  // ── Confirmation prompts ──────────────────────────────────────

  if (!YES) {
    const confirm1 = await askYesNo(`${c.bold}Are you sure you want to delete everything?${c.reset}`);
    if (!confirm1) {
      console.log(`\n  ${c.green}Teardown cancelled.${c.reset}\n`);
      rl.close();
      return;
    }

    const confirm2 = await askYesNo(
      `${c.bold}${c.orange}This cannot be undone. Continue?${c.reset}`
    );
    if (!confirm2) {
      console.log(`\n  ${c.green}Teardown cancelled.${c.reset}\n`);
      rl.close();
      return;
    }
  }

  rl.close();
  console.log("");

  // ── Delete connector workers ──────────────────────────────────
  // Connectors first, then queue (router is a queue consumer and
  // can't be deleted while the queue still references it), then
  // core workers, then remaining resources.

  console.log(`  ${c.bold}${c.white}Deleting workers...${c.reset}\n`);

  // Connector workers
  for (const worker of connectorWorkers) {
    const result = run(`npx wrangler delete --name ${worker} --force`);
    if (result.success) {
      console.log(`  ${c.green}✓${c.reset} Deleted ${worker}`);
    } else {
      console.log(`  ${c.dim}⏭ ${worker} (not found or already deleted)${c.reset}`);
    }
  }

  // Dashboard first (no queue dependency)
  {
    const result = run(`npx wrangler delete --name openchief-dashboard --force`);
    if (result.success) {
      console.log(`  ${c.green}✓${c.reset} Deleted openchief-dashboard`);
    } else {
      console.log(`  ${c.dim}⏭ openchief-dashboard (not found or already deleted)${c.reset}`);
    }
  }

  // Queue must be deleted before the router (router is a queue consumer)
  if (!isLocal) {
    const qResult = run(`npx wrangler queues delete ${queueName}`);
    if (qResult.success) {
      console.log(`  ${c.green}✓${c.reset} Deleted queue ${queueName}`);
    } else {
      console.log(`  ${c.dim}⏭ Queue ${queueName} (not found or already deleted)${c.reset}`);
    }
  }

  // Now router and runtime can be deleted
  for (const worker of ["openchief-router", "openchief-runtime"]) {
    const result = run(`npx wrangler delete --name ${worker} --force`);
    if (result.success) {
      console.log(`  ${c.green}✓${c.reset} Deleted ${worker}`);
    } else {
      console.log(`  ${c.dim}⏭ ${worker} (not found or already deleted)${c.reset}`);
    }
  }

  if (isLocal) {
    console.log(`\n  ${c.dim}Skipping resource deletion (local mode)${c.reset}`);
  } else {
    // ── Delete remaining Cloudflare resources ───────────────────

    console.log(`\n  ${c.bold}${c.white}Deleting remaining resources...${c.reset}\n`);

    // Vectorize (optional)
    if (vectorizeName) {
      const vzResult = run(`npx wrangler vectorize delete ${vectorizeName} --force`);
      if (vzResult.success) {
        console.log(`  ${c.green}✓${c.reset} Deleted Vectorize index ${vectorizeName}`);
      } else {
        console.log(`  ${c.dim}⏭ Vectorize ${vectorizeName} (not found or already deleted)${c.reset}`);
      }
    }

    // KV
    if (kvId && kvId !== "local-placeholder") {
      const kvResult = run(`npx wrangler kv namespace delete --namespace-id ${kvId}`);
      if (kvResult.success) {
        console.log(`  ${c.green}✓${c.reset} Deleted KV namespace`);
      } else {
        console.log(`  ${c.dim}⏭ KV namespace (not found or already deleted)${c.reset}`);
      }
    }

    // D1
    if (d1Id && d1Id !== "local-placeholder") {
      const d1Result = run(`npx wrangler d1 delete openchief-db --skip-confirmation`);
      if (d1Result.success) {
        console.log(`  ${c.green}✓${c.reset} Deleted D1 database`);
      } else {
        console.log(`  ${c.dim}⏭ D1 database (not found or already deleted)${c.reset}`);
      }
    }
  }

  // ── Remove config file ────────────────────────────────────────

  if (!KEEP_CONFIG) {
    console.log(`\n  ${c.bold}${c.white}Cleaning up...${c.reset}\n`);
    try {
      unlinkSync(configPath);
      console.log(`  ${c.green}✓${c.reset} Removed openchief.config.ts`);
    } catch (err) {
      console.log(`  ${c.yellow}⚠${c.reset}  Could not remove config: ${(err as Error).message}`);
    }
  } else {
    console.log(`\n  ${c.dim}Keeping openchief.config.ts (--keep-config)${c.reset}`);
  }

  // ── Done ──────────────────────────────────────────────────────

  console.log("");
  console.log(`${c.green}   ┌──────────────────────────────────────┐${c.reset}`);
  console.log(`${c.green}   │                                      │${c.reset}`);
  console.log(`${c.green}   │   ${c.bold}${c.white}Teardown complete!${c.reset}${c.green}                 │${c.reset}`);
  console.log(`${c.green}   │                                      │${c.reset}`);
  console.log(`${c.green}   └──────────────────────────────────────┘${c.reset}`);
  console.log("");
  console.log(`  ${c.bold}${c.white}To start fresh:${c.reset}`);
  console.log(`  ${c.orange}1.${c.reset} ${c.cyan}pnpm run setup${c.reset}`);
  console.log(`  ${c.orange}2.${c.reset} ${c.cyan}pnpm run deploy${c.reset}`);
  console.log("");
}

main().catch((err) => {
  console.error("Teardown failed:", err);
  rl.close();
  process.exit(1);
});
