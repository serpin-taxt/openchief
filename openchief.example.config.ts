import type { OpenChiefConfig } from "@openchief/shared";

const config: OpenChiefConfig = {
  /** Your organization info — used in agent prompts and dashboard branding */
  instance: {
    name: "OpenChief",
    orgName: "My Company",
    context:
      "We build developer tools. 15-person engineering team, 5-person product team.",
  },

  /** Cloudflare account and resource IDs */
  cloudflare: {
    accountId: "",
    d1DatabaseId: "",
    kvNamespaceId: "",
    queueName: "openchief-events",
    vectorizeIndexName: "",
  },

  /** AI runtime settings */
  runtime: {
    defaultModel: "claude-sonnet-4-6",
    reportTimezone: "America/Chicago",
    reportTimeUtcHour: 14,
  },

  /**
   * Authentication
   *   "none"               — Open access (local dev / VPN)
   *   "cloudflare-access"  — SSO via Cloudflare Zero Trust (requires an Access policy
   *                          for your dashboard URL — create one at
   *                          https://one.dash.cloudflare.com → Access → Applications)
   *   "password"           — Single admin password login
   */
  auth: {
    provider: "none",
    // teamDomain: "your-team.cloudflareaccess.com", // required for "cloudflare-access"
    // For "password" mode: run `wrangler secret put ADMIN_PASSWORD` in workers/dashboard
  },

  /** GitHub integration */
  github: {
    repo: "your-org/your-repo",
  },

  /** Connectors to enable */
  connectors: {
    github: { enabled: true },
    slack: { enabled: true },
    discord: { enabled: false },
    jira: { enabled: false },
    notion: { enabled: false },
    figma: { enabled: false },
    intercom: { enabled: false },
    twitter: { enabled: false },
    amplitude: { enabled: false },
    "google-calendar": { enabled: false },
    "google-analytics": { enabled: false },
    quickbooks: { enabled: false },
  },
};

export default config;
