#!/usr/bin/env npx tsx
/**
 * OpenChief Interactive Setup Wizard
 *
 * Guides new users through configuring their OpenChief instance.
 * Supports two modes:
 *   - Local development: run locally with wrangler dev (no Cloudflare account needed)
 *   - Deploy to Cloudflare: create remote resources and deploy workers
 *
 * Usage: pnpm run setup
 */

import { createInterface } from "readline";
import { writeFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_MODE = process.argv.includes("--test");

// ── Readline helpers ─────────────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    rl.question(`  ${question} ${hint}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

// ── ANSI colors ─────────────────────────────────────────────────────────

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

type SetupMode = "local" | "deploy";

let totalSteps = 5;
let currentStep = 0;

function print(text: string) {
  console.log(text);
}

function header(text: string) {
  currentStep++;
  const filled = currentStep;
  const empty = totalSteps - filled;
  const bar = `${c.orange}${"█".repeat(filled)}${c.gray}${"░".repeat(empty)}${c.reset}`;

  print("");
  print(`  ${bar}  ${c.dim}${currentStep}/${totalSteps}${c.reset}`);
  print(`  ${c.bold}${c.orange}${text}${c.reset}`);
  print(`  ${c.dim}${"─".repeat(50)}${c.reset}`);
  print("");
}

function run(cmd: string, options?: { cwd?: string }): string {
  try {
    return execSync(cmd, {
      cwd: options?.cwd || ROOT,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(e.stderr || e.message || "Command failed");
  }
}

// ── Connectors ───────────────────────────────────────────────────────────

const CONNECTORS = [
  { key: "github", label: "GitHub", description: "PRs, issues, commits, reviews" },
  { key: "slack", label: "Slack", description: "Messages, threads, reactions" },
  { key: "discord", label: "Discord", description: "Messages, threads, reactions" },
  { key: "jira", label: "Jira", description: "Issues, sprints, boards" },
  { key: "notion", label: "Notion", description: "Pages, databases, comments" },
  { key: "figma", label: "Figma", description: "Files, comments, library updates" },
  { key: "intercom", label: "Intercom", description: "Conversations, tickets" },
  { key: "twitter", label: "Twitter / X", description: "Tweets, mentions, search" },
  { key: "amplitude", label: "Amplitude", description: "Product analytics events" },
  { key: "google-calendar", label: "Google Calendar", description: "Events, meetings" },
  { key: "google-analytics", label: "Google Analytics", description: "Web analytics" },
  { key: "quickbooks", label: "QuickBooks", description: "Financial data" },
  { key: "jpd", label: "Jira Product Discovery", description: "Ideas, insights, delivery tracking" },
  { key: "rippling", label: "Rippling", description: "HR, payroll, employee data" },
];


// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // ── Banner ───────────────────────────────────────────────────────────
  print("");
  print(`  ${c.orange}              /\\${c.reset}`);
  print(`  ${c.orange}       /\\    /  \\    /\\${c.reset}`);
  print(`  ${c.amber}      /  \\  /    \\  /  \\${c.reset}`);
  print(`  ${c.amber}     /    \\/      \\/    \\${c.reset}`);
  print(`  ${c.yellow}     \\                   /${c.reset}`);
  print(`  ${c.yellow}      \`-----------------'${c.reset}`);
  print("");
  print(`  ${c.bold}${c.white}     O p e n C h i e f${c.reset}`);
  print(`  ${c.dim}     AI agents for your business tools${c.reset}`);

  // ── Test mode (--test flag) ─────────────────────────────────────────
  if (TEST_MODE) {
    print(`\n  ${c.yellow}⚡ Test mode${c.reset} ${c.dim}— skipping prompts, using defaults${c.reset}\n`);
  }

  // ── Mode selection ───────────────────────────────────────────────────
  let mode: SetupMode;
  if (TEST_MODE) {
    mode = "deploy";
  } else {
    print("");
    print(`  ${c.white}How do you want to run OpenChief?${c.reset}`);
    print("");
    print(`  ${c.orange}  1.${c.reset} ${c.white}Deploy to Cloudflare${c.reset}   ${c.dim}Create resources & deploy workers ${c.green}(Recommended)${c.reset}`);
    print(`  ${c.gray}  2.${c.reset} ${c.white}Local development${c.reset}      ${c.dim}Run locally with wrangler dev${c.reset}`);
    print("");
    const modeChoice = await ask("Select (1-2)", "1");
    mode = modeChoice === "2" ? "local" : "deploy";
  }
  totalSteps = mode === "deploy" ? 4 : 2;

  // ── Step outline ─────────────────────────────────────────────────────
  if (!TEST_MODE) {
    print("");
    if (mode === "local") {
      print(`  ${c.white}This wizard will walk you through:${c.reset}`);
      print(`  ${c.gray}  1.${c.reset} Organization info`);
      print(`  ${c.gray}  2.${c.reset} Configure & seed      ${c.dim}(local database)${c.reset}`);
    } else {
      print(`  ${c.white}This wizard will walk you through:${c.reset}`);
      print(`  ${c.gray}  1.${c.reset} Organization info`);
      print(`  ${c.gray}  2.${c.reset} Authentication`);
      print(`  ${c.gray}  3.${c.reset} Cloudflare resources  ${c.dim}(D1, KV, Queue, Vectorize)${c.reset}`);
      print(`  ${c.gray}  4.${c.reset} Deploy & configure`);
    }
    print("");
  }

  // ── Step 1: Organization ──────────────────────────────────────────────
  let orgName: string;
  let orgContext: string;
  if (TEST_MODE) {
    orgName = "Test Company";
    orgContext = "Test setup for development.";
    print(`  ${c.green}✓${c.reset} Org: ${orgName}`);
  } else {
    header("Organization");
    orgName = await ask("Company/org name", "My Company");
    orgContext = await ask(
      "Brief description (used in agent prompts)",
      "We build software. ~10 person team."
    );
  }

  // ── Authentication ──────────────────────────────────────────────────────
  let authProvider: "none" | "cloudflare-access" | "password" = "none";
  let cfAccessTeamDomain = "";
  let superadminEmail = "";
  if (!TEST_MODE && mode === "deploy") {
    header("Authentication");
    print(`  ${c.white}How should the dashboard be protected?${c.reset}`);
    print("");
    print(`  ${c.orange}  1.${c.reset} ${c.white}Cloudflare Access${c.reset}    ${c.dim}SSO via Cloudflare Zero Trust ${c.green}(Recommended)${c.reset}`);
    print(`  ${c.dim}                            Free for up to 50 users${c.reset}`);
    print(`  ${c.orange}  2.${c.reset} ${c.white}Admin password${c.reset}       ${c.dim}Single password login${c.reset}`);
    print(`  ${c.orange}  3.${c.reset} ${c.white}No auth${c.reset}              ${c.dim}Open access (VPN-protected only)${c.reset}`);
    print("");
    const authChoice = await ask("Select (1-3)", "1");
    if (authChoice === "1") {
      authProvider = "cloudflare-access";
      print("");
      print(`  ${c.dim}After deploy, you'll set up a Cloudflare Access application${c.reset}`);
      print(`  ${c.dim}to protect your dashboard. The deploy script will show the steps.${c.reset}`);
    } else if (authChoice === "2") {
      authProvider = "password";
    }

    // Superadmin email (for Cloudflare Access or password auth)
    if (authProvider !== "none") {
      print("");
      print(`  ${c.white}Superadmin email${c.reset}`);
      print(`  ${c.dim}This user gets full access: connections, exec agents, and role management.${c.reset}`);
      print(`  ${c.dim}Other users will have limited access by default.${c.reset}`);
      superadminEmail = await ask("Email address");
    }
  }

  // ── Step 2 (deploy only): Cloudflare ──────────────────────────────────
  let accountId = "";
  let d1DatabaseId = "";
  let kvNamespaceId = "";
  let vectorizeIndexName = "";
  let hasWrangler = false;

  // Check if wrangler is available (needed for both modes)
  try {
    run("npx wrangler --version");
    hasWrangler = true;
  } catch {
    // wrangler not available
  }

  if (mode === "deploy") {
    if (!TEST_MODE) header("Cloudflare Account");

    if (!hasWrangler) {
      print(`  ${c.yellow}⚠${c.reset}  wrangler not found. You'll need to create resources manually.`);
    }

    // Try to auto-detect accounts from wrangler
    if (hasWrangler) {
      if (!TEST_MODE) {
        print(`  ${c.dim}Accounts are pulled from your wrangler session.${c.reset}`);
        print(`  ${c.dim}To switch accounts: ${c.cyan}npx wrangler logout${c.reset}${c.dim} then ${c.cyan}npx wrangler login${c.reset}\n`);
      }

      try {
        const whoamiOutput = run("npx wrangler whoami");
        // Parse account table — lines like "│ Account Name │ account_id │"
        const accountLines = whoamiOutput
          .split("\n")
          .filter((line) => line.includes("│") && !line.includes("Account Name") && !line.includes("─"))
          .map((line) => {
            const cells = line.split("│").map((c) => c.trim()).filter(Boolean);
            return cells.length >= 2 ? { name: cells[0], id: cells[1] } : null;
          })
          .filter(Boolean) as Array<{ name: string; id: string }>;

        if (TEST_MODE && accountLines.length >= 1) {
          // Test mode — use first account automatically
          accountId = accountLines[0].id;
          print(`  ${c.green}✓${c.reset} Account: ${c.white}${accountLines[0].name}${c.reset}`);
        } else if (accountLines.length === 1) {
          accountId = accountLines[0].id;
          print(`  ${c.green}✓${c.reset} Detected account: ${c.white}${accountLines[0].name}${c.reset}`);
          print(`  ${c.dim}  ${accountId}${c.reset}\n`);
        } else if (accountLines.length > 1) {
          print(`  ${c.white}Multiple Cloudflare accounts detected:${c.reset}\n`);
          for (let i = 0; i < accountLines.length; i++) {
            print(`  ${c.orange}  ${i + 1}.${c.reset} ${accountLines[i].name}  ${c.dim}${accountLines[i].id}${c.reset}`);
          }
          print("");
          const choice = await ask(`Select account (1-${accountLines.length})`, "1");
          const idx = parseInt(choice, 10) - 1;
          if (idx >= 0 && idx < accountLines.length) {
            accountId = accountLines[idx].id;
            print(`  ${c.green}✓${c.reset} Using: ${c.white}${accountLines[idx].name}${c.reset}\n`);
          }
        }
      } catch {
        print(`  ${c.yellow}⚠${c.reset}  Not logged in. Run ${c.cyan}npx wrangler login${c.reset} first, or enter your Account ID manually.\n`);
      }
    }

    if (!accountId) {
      print(`  ${c.white}Enter your Cloudflare Account ID.${c.reset}`);
      print(`  ${c.dim}Find it at: ${c.cyan}https://dash.cloudflare.com${c.reset}${c.dim} → right sidebar${c.reset}\n`);
      accountId = await ask("Cloudflare Account ID");
    }

    if (!accountId) {
      print(`\n  ${c.orange}✗${c.reset} Account ID is required. Exiting.`);
      rl.close();
      process.exit(1);
    }

    // Set account ID env var so all wrangler commands pick it up automatically
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

    if (hasWrangler) {
      const createResources = TEST_MODE ? true : await askYesNo("Create Cloudflare resources (D1, KV, Queue) automatically?");

      if (createResources) {
        // ── D1 database ──
        print(`\n  ${c.dim}Creating D1 database...${c.reset}`);
        try {
          const listOutput = run("npx wrangler d1 list --json");
          const dbs = JSON.parse(listOutput);
          const existing = dbs.find((db: { name: string }) => db.name === "openchief-db");
          if (existing) {
            d1DatabaseId = existing.uuid;
            print(`  ${c.green}✓${c.reset} D1 database exists    ${c.dim}${d1DatabaseId}${c.reset}`);
          } else {
            const d1Output = run("npx wrangler d1 create openchief-db");
            const d1Match = d1Output.match(/"database_id"\s*:\s*"([^"]+)"/);
            if (d1Match) {
              d1DatabaseId = d1Match[1];
              print(`  ${c.green}✓${c.reset} D1 database created   ${c.dim}${d1DatabaseId}${c.reset}`);
            }
          }
        } catch (err) {
          print(`  ${c.yellow}⚠${c.reset}  Could not create D1 database: ${(err as Error).message}`);
        }

        // ── KV namespace ──
        print(`  ${c.dim}Creating KV namespace...${c.reset}`);
        try {
          const kvListOutput = run("npx wrangler kv namespace list");
          const kvNamespaces = JSON.parse(kvListOutput);
          const existingKv = kvNamespaces.find((ns: { title: string }) =>
            ns.title === "OPENCHIEF_KV" || ns.title.includes("OPENCHIEF_KV")
          );
          if (existingKv) {
            kvNamespaceId = existingKv.id;
            print(`  ${c.green}✓${c.reset} KV namespace exists   ${c.dim}${kvNamespaceId}${c.reset}`);
          } else {
            const kvOutput = run("npx wrangler kv namespace create OPENCHIEF_KV");
            const kvMatch = kvOutput.match(/"id"\s*:\s*"([^"]+)"/);
            if (kvMatch) {
              kvNamespaceId = kvMatch[1];
              print(`  ${c.green}✓${c.reset} KV namespace created  ${c.dim}${kvNamespaceId}${c.reset}`);
            }
          }
        } catch (err) {
          print(`  ${c.yellow}⚠${c.reset}  Could not create KV namespace: ${(err as Error).message}`);
        }

        // ── Queue ──
        print(`  ${c.dim}Creating events queue...${c.reset}`);
        try {
          run("npx wrangler queues create openchief-events");
          print(`  ${c.green}✓${c.reset} Queue created          ${c.dim}openchief-events${c.reset}`);
        } catch {
          print(`  ${c.green}✓${c.reset} Queue ready            ${c.dim}openchief-events${c.reset}`);
        }

        // ── Vectorize index (for RAG) ──
        print(`  ${c.dim}Creating Vectorize index (RAG)...${c.reset}`);
        try {
          const vzListOutput = run("npx wrangler vectorize list");
          if (vzListOutput.includes("openchief-agents")) {
            vectorizeIndexName = "openchief-agents";
            print(`  ${c.green}✓${c.reset} Vectorize index exists ${c.dim}${vectorizeIndexName}${c.reset}`);
          } else {
            run("npx wrangler vectorize create openchief-agents --dimensions 768 --metric cosine");
            vectorizeIndexName = "openchief-agents";
            print(`  ${c.green}✓${c.reset} Vectorize index created ${c.dim}${vectorizeIndexName}${c.reset}`);
          }
        } catch (err) {
          print(`  ${c.yellow}⚠${c.reset}  Could not create Vectorize index: ${(err as Error).message}`);
          print(`  ${c.dim}  RAG will be disabled. You can create it later with:${c.reset}`);
          print(`  ${c.dim}  npx wrangler vectorize create openchief-agents --dimensions 768 --metric cosine${c.reset}`);
        }
      }
    }

    if (!d1DatabaseId) {
      print(`\n  ${c.white}Enter your existing Cloudflare resource IDs.${c.reset}`);
      print(`  ${c.dim}Create them in the Cloudflare dashboard, or re-run and select auto-create.${c.reset}\n`);
      d1DatabaseId = await ask("D1 Database ID");
    }
    if (!kvNamespaceId) {
      kvNamespaceId = await ask("KV Namespace ID");
    }
  } else {
    // Local mode — use placeholders (wrangler dev creates local bindings automatically)
    accountId = "local";
    d1DatabaseId = "local-placeholder";
    kvNamespaceId = "local-placeholder";

    if (!hasWrangler) {
      print(`  ${c.yellow}⚠${c.reset}  wrangler not found. Local dev requires wrangler.`);
      print(`  ${c.dim}  Install: pnpm add -D wrangler${c.reset}\n`);
    }
  }

  const anthropicKey = "";
  const defaultModel = "claude-sonnet-4-6";
  const reportHour = "14";

  // ── Connectors (defaults — configure in dashboard) ─────────────────────
  const enabledConnectors: Record<string, boolean> = {};
  for (const conn of CONNECTORS) {
    enabledConnectors[conn.key] = conn.key === "github" || conn.key === "slack";
  }

  // ── Final step: Generate config, migrate, seed ─────────────────────────
  const githubRepo = "";
  if (!TEST_MODE) header(mode === "local" ? "Configure & Seed" : "Deploy & Configure");

  const configContent = `import type { OpenChiefConfig } from "@openchief/shared";

const config: OpenChiefConfig = {
  instance: {
    name: "OpenChief",
    orgName: ${JSON.stringify(orgName)},
    context: ${JSON.stringify(orgContext)},
  },

  cloudflare: {
    accountId: ${JSON.stringify(accountId)},
    d1DatabaseId: ${JSON.stringify(d1DatabaseId)},
    kvNamespaceId: ${JSON.stringify(kvNamespaceId)},
    queueName: "openchief-events",${vectorizeIndexName ? `\n    vectorizeIndexName: ${JSON.stringify(vectorizeIndexName)},` : ""}
  },

  runtime: {
    defaultModel: ${JSON.stringify(defaultModel)},
    reportTimezone: "UTC",
    reportTimeUtcHour: ${parseInt(reportHour, 10) || 14},
  },

  auth: {
    provider: ${JSON.stringify(authProvider)},${cfAccessTeamDomain ? `\n    teamDomain: ${JSON.stringify(cfAccessTeamDomain)},` : ""}${superadminEmail ? `\n    superadminEmail: ${JSON.stringify(superadminEmail)},` : ""}
  },

  ${githubRepo ? `github: {\n    repo: ${JSON.stringify(githubRepo)},\n  },\n` : ""}
  connectors: {
${Object.entries(enabledConnectors)
  .map(([key, enabled]) => `    ${JSON.stringify(key)}: { enabled: ${enabled} },`)
  .join("\n")}
  },
};

export default config;
`;

  const configPath = resolve(ROOT, "openchief.config.ts");
  writeFileSync(configPath, configContent);
  print(`  ${c.green}✓${c.reset} Generated openchief.config.ts`);

  // ── Generate wrangler configs ─────────────────────────────────────────
  print(`  ${c.dim}Updating wrangler.jsonc files...${c.reset}`);
  try {
    run("npx tsx scripts/generate-config.ts");
    print(`  ${c.green}✓${c.reset} Wrangler configs updated`);
  } catch (err) {
    print(`  ${c.yellow}⚠${c.reset}  Config generation had issues: ${(err as Error).message}`);
  }

  // ── Set admin password secret (password auth only) ─────────────────────
  if (authProvider === "password" && mode === "deploy" && hasWrangler) {
    print(`\n  ${c.white}Setting admin password as a Wrangler secret...${c.reset}`);
    print(`  ${c.dim}You'll be prompted to enter the password.${c.reset}\n`);
    try {
      execSync(
        "npx wrangler secret put ADMIN_PASSWORD -c workers/dashboard/wrangler.jsonc",
        { cwd: ROOT, stdio: "inherit" },
      );
      print(`  ${c.green}✓${c.reset} ADMIN_PASSWORD set`);
    } catch {
      print(`  ${c.yellow}⚠${c.reset}  Could not set ADMIN_PASSWORD. Run manually:`);
      print(`  ${c.cyan}  cd workers/dashboard && npx wrangler secret put ADMIN_PASSWORD${c.reset}`);
    }
  }

  // ── Run migrations ────────────────────────────────────────────────────
  if (hasWrangler && (mode === "local" || d1DatabaseId)) {
    const d1Flag = mode === "local" ? "--local" : "--remote";
    print(`\n  ${c.dim}Applying ${mode === "local" ? "local" : "remote"} migrations...${c.reset}`);
    const migrationsDir = resolve(ROOT, "migrations");

    // Auto-discover all .sql migration files, sorted by name
    const files = readdirSync(migrationsDir)
      .filter((f: string) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const sqlPath = resolve(migrationsDir, file);
      try {
        run(`npx wrangler d1 execute openchief-db ${d1Flag} -c workers/router/wrangler.jsonc --file="${sqlPath}"`);
        print(`  ${c.green}✓${c.reset} ${file}`);
      } catch {
        print(`  ${c.dim}⏭ ${file} (already applied)${c.reset}`);
      }
    }
  }

  // ── Seed agents ────────────────────────────────────────────────────────
  if (hasWrangler) {
    print(`\n  ${c.dim}Seeding agents...${c.reset}`);
    try {
      process.env.OPENCHIEF_D1_MODE = mode === "deploy" ? "remote" : "local";
      run("npx tsx scripts/seed-agents.ts");
      print(`  ${c.green}✓${c.reset} Agents seeded`);
    } catch (err) {
      print(`  ${c.yellow}⚠${c.reset}  Seed error: ${(err as Error).message}`);
      print(`  ${c.dim}You can seed manually later: pnpm seed${c.reset}`);
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────
  if (TEST_MODE) {
    print(`\n  ${c.green}✓${c.reset} ${c.bold}Test setup complete!${c.reset} Run ${c.cyan}pnpm run deploy${c.reset} to deploy.\n`);
  } else {
    print("");
    print(`  ${c.orange}${"█".repeat(totalSteps)}${c.reset}  ${c.dim}${totalSteps}/${totalSteps}${c.reset}`);
    print("");
    print(`${c.green}   ┌─────────────────────────────────────────────┐${c.reset}`);
    print(`${c.green}   │                                             │${c.reset}`);
    print(`${c.green}   │   ${c.bold}${c.white}Setup complete!${c.reset}${c.green}                          │${c.reset}`);
    print(`${c.green}   │                                             │${c.reset}`);

    if (mode === "local") {
      print(`${c.green}   │${c.reset}   Ready to run locally.                    ${c.green}│${c.reset}`);
    } else {
      print(`${c.green}   │${c.reset}   Your OpenChief instance is configured.   ${c.green}│${c.reset}`);
    }

    print(`${c.green}   │                                             │${c.reset}`);
    print(`${c.green}   └─────────────────────────────────────────────┘${c.reset}`);
    print("");
    print(`  ${c.bold}${c.white}Next steps:${c.reset}`);
    print("");

    if (mode === "local") {
      print(`  ${c.orange}1.${c.reset} Start dev servers    ${c.cyan}pnpm dev${c.reset}`);
      print(`  ${c.dim}   Dashboard: http://localhost:5173${c.reset}`);
      print(`  ${c.dim}   Runtime:   http://localhost:8787${c.reset}`);
      print("");
      print(`  ${c.dim}To deploy to Cloudflare later, run: pnpm run setup${c.reset}`);
    } else {
      print(`  ${c.orange}1.${c.reset} Deploy workers     ${c.cyan}pnpm run deploy${c.reset}`);
      print(`  ${c.dim}   This will build and deploy all workers to Cloudflare.${c.reset}`);
      if (authProvider === "cloudflare-access") {
        print(`  ${c.dim}   The deploy script will show Cloudflare Access setup steps.${c.reset}`);
      }
    }
    print("");
  }

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
