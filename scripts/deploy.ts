#!/usr/bin/env npx tsx
/**
 * Deploy all OpenChief workers to Cloudflare.
 *
 * Reads openchief.config.ts to determine which connectors are enabled,
 * then deploys core workers + enabled connectors in the correct order.
 *
 * Usage: npx tsx scripts/deploy.ts
 */

import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

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

function run(cmd: string, cwd: string): { success: boolean; output: string } {
  console.log(`  ${c.dim}→${c.reset} ${cmd}`);
  try {
    const output = execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
    // Print output but dimmed to keep it readable
    if (output.trim()) {
      for (const line of output.trim().split("\n")) {
        console.log(`  ${c.dim}${line}${c.reset}`);
      }
    }
    return { success: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    if (e.stderr) console.error(e.stderr);
    if (e.stdout) console.log(e.stdout);
    return { success: false, output: e.stdout || "" };
  }
}

async function main() {
  console.log("");
  console.log(`  ${c.orange}              /\\${c.reset}`);
  console.log(`  ${c.orange}       /\\    /  \\    /\\${c.reset}`);
  console.log(`  ${c.amber}      /  \\  /    \\  /  \\${c.reset}`);
  console.log(`  ${c.amber}     /    \\/      \\/    \\${c.reset}`);
  console.log(`  ${c.yellow}     \\                   /${c.reset}`);
  console.log(`  ${c.yellow}      \`-----------------'${c.reset}`);
  console.log("");
  console.log(`  ${c.bold}${c.white}     O p e n C h i e f${c.reset}  ${c.dim}deploy${c.reset}`);
  console.log("");

  // Load config to check which connectors are enabled
  const configPath = resolve(ROOT, "openchief.config.ts");
  if (!existsSync(configPath)) {
    console.error("❌ openchief.config.ts not found. Run `pnpm run setup` first.");
    process.exit(1);
  }

  const configModule = await import(configPath);
  const config = configModule.default;

  // Build first
  console.log(`  ${c.bold}${c.white}Building all packages...${c.reset}\n`);
  execSync("pnpm build", { cwd: ROOT, stdio: "inherit" });
  console.log(`\n  ${c.green}✓${c.reset} Build complete\n`);

  // Deploy core workers in order
  const coreWorkers = [
    { name: "Runtime", path: "workers/runtime" },
    { name: "Router", path: "workers/router" },
    { name: "Dashboard", path: "workers/dashboard" },
  ];

  let dashboardUrl = "";

  console.log(`  ${c.bold}${c.white}Deploying core workers...${c.reset}\n`);
  for (const worker of coreWorkers) {
    const workerPath = resolve(ROOT, worker.path);
    console.log(`\n  ${c.orange}──${c.reset} ${c.bold}${worker.name}${c.reset} ${c.orange}──${c.reset}`);
    const result = run("npx wrangler deploy", workerPath);
    if (!result.success) {
      console.error(`  ${c.orange}✗${c.reset} Failed to deploy ${worker.name}`);
    } else {
      console.log(`  ${c.green}✓${c.reset} ${worker.name} deployed`);
      // Capture the dashboard URL from wrangler output
      if (worker.name === "Dashboard") {
        const urlMatch = result.output.match(/https:\/\/openchief-dashboard\.[^\s]+\.workers\.dev/);
        if (urlMatch) dashboardUrl = urlMatch[0];
      }
    }
  }

  // Deploy enabled connectors
  const connectorMap: Record<string, string> = {
    github: "workers/connectors/github",
    slack: "workers/connectors/slack",
    discord: "workers/connectors/discord",
    jira: "workers/connectors/jira",
    notion: "workers/connectors/notion",
    figma: "workers/connectors/figma",
    intercom: "workers/connectors/intercom",
    twitter: "workers/connectors/twitter",
    amplitude: "workers/connectors/amplitude",
    "google-calendar": "workers/connectors/google-calendar",
    "google-analytics": "workers/connectors/google-analytics",
    quickbooks: "workers/connectors/quickbooks",
    jpd: "workers/connectors/jpd",
    rippling: "workers/connectors/rippling",
  };

  const enabledConnectors = Object.entries(config.connectors || {})
    .filter(([, v]: [string, { enabled: boolean }]) => v.enabled)
    .map(([k]) => k);

  if (enabledConnectors.length > 0) {
    console.log(`\n  ${c.bold}${c.white}Deploying connectors...${c.reset}\n`);
    for (const connector of enabledConnectors) {
      const path = connectorMap[connector];
      if (!path) {
        console.log(`  ${c.dim}⏭ ${connector} (no worker directory yet)${c.reset}`);
        continue;
      }
      const connectorPath = resolve(ROOT, path);
      if (!existsSync(connectorPath)) {
        console.log(`  ${c.dim}⏭ ${connector} (directory not found)${c.reset}`);
        continue;
      }
      console.log(`\n  ${c.orange}──${c.reset} ${c.bold}${connector}${c.reset} ${c.orange}──${c.reset}`);
      const result = run("npx wrangler deploy", connectorPath);
      if (result.success) {
        console.log(`  ${c.green}✓${c.reset} ${connector} deployed`);
      }
    }
  }

  console.log("");
  console.log(`${c.green}   ┌──────────────────────────────────────┐${c.reset}`);
  console.log(`${c.green}   │                                      │${c.reset}`);
  console.log(`${c.green}   │   ${c.bold}${c.white}Deploy complete!${c.reset}${c.green}                   │${c.reset}`);
  console.log(`${c.green}   │                                      │${c.reset}`);
  console.log(`${c.green}   └──────────────────────────────────────┘${c.reset}`);
  console.log("");

  if (dashboardUrl) {
    console.log(`  ${c.bold}${c.white}Dashboard:${c.reset}  ${c.cyan}${dashboardUrl}${c.reset}`);
  }
  console.log("");

  const authProvider = config.auth?.provider || "none";

  // Show Cloudflare Access setup instructions
  if (authProvider === "cloudflare-access" && dashboardUrl) {
    const dashboardHostname = new URL(dashboardUrl).hostname;
    console.log(`  ${c.bold}${c.white}⚡ Set up Cloudflare Access${c.reset}  ${c.dim}(free for up to 50 users)${c.reset}`);
    console.log("");
    console.log(`  ${c.orange}1.${c.reset} Go to ${c.cyan}https://one.dash.cloudflare.com${c.reset}`);
    console.log(`  ${c.orange}2.${c.reset} Navigate to ${c.white}Access → Applications → Add an application${c.reset}`);
    console.log(`  ${c.orange}3.${c.reset} Select ${c.white}Self-hosted${c.reset}`);
    console.log(`  ${c.orange}4.${c.reset} Set the application domain to:`);
    console.log(`     ${c.cyan}${dashboardHostname}${c.reset}`);
    console.log(`  ${c.orange}5.${c.reset} Add an ${c.white}Allow${c.reset} policy (e.g. emails ending in ${c.white}@yourcompany.com${c.reset})`);
    console.log(`     ${c.dim}One-time PIN works out of the box — no identity provider needed${c.reset}`);
    console.log(`  ${c.orange}6.${c.reset} Copy your team domain and set it in ${c.white}wrangler.jsonc${c.reset}:`);
    console.log(`     ${c.cyan}"CF_ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com"${c.reset}`);
    console.log("");
  }

  console.log(`  ${c.bold}${c.white}Next steps:${c.reset}`);
  let step = 1;
  if (authProvider === "cloudflare-access") {
    console.log(`  ${c.orange}${step}.${c.reset} Set up Cloudflare Access ${c.dim}(see instructions above)${c.reset}`);
    step++;
  }
  console.log(`  ${c.orange}${step}.${c.reset} Open the dashboard and add your Anthropic API key`);
  step++;
  console.log(`  ${c.orange}${step}.${c.reset} Configure connector secrets ${c.dim}(GitHub token, Slack token, etc.)${c.reset}`);
  step++;
  console.log(`  ${c.orange}${step}.${c.reset} Enable the agents you want to use`);
  console.log("");
}

main().catch((err) => {
  console.error("Deploy failed:", err);
  process.exit(1);
});
