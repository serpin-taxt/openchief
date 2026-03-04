/**
 * OpenChief instance configuration.
 *
 * This is the central config file that drives the entire deployment.
 * Users copy `openchief.example.config.ts` to `openchief.config.ts`
 * and fill in their values. The setup script reads this to generate
 * wrangler.jsonc files and deploy workers.
 */
export interface OpenChiefConfig {
  /** Organization identity — used in prompts and dashboard branding */
  instance: {
    /** Display name for this OpenChief instance */
    name: string;
    /** Your organization name */
    orgName: string;
    /**
     * Brief context about your company/team.
     * Injected into agent prompts so they understand your domain.
     * Example: "We build developer tools. 15-person eng team."
     */
    context: string;
  };

  /** Cloudflare account and resource configuration */
  cloudflare: {
    /** Cloudflare account ID */
    accountId: string;
    /** D1 database ID (created by setup script or manually) */
    d1DatabaseId: string;
    /** KV namespace ID (created by setup script or manually) */
    kvNamespaceId: string;
    /** Queue name for event routing (default: "openchief-events") */
    queueName: string;
    /**
     * Prefix for all worker names and resource references (default: "openchief").
     * Controls worker names (e.g. "{prefix}-runtime"), service bindings, DO script
     * names, and D1 database names. Use a unique prefix per deployment to avoid
     * naming collisions (e.g. "openchief-internal", "openchief-staging").
     */
    workerNamePrefix?: string;
    /** Vectorize index name for RAG (optional — RAG disabled when not set) */
    vectorizeIndexName?: string;
  };

  /** AI runtime configuration */
  runtime: {
    /** Default Claude model for reports (e.g. "claude-sonnet-4-6") */
    defaultModel: string;
    /** Timezone for scheduling reports (e.g. "America/Chicago") */
    reportTimezone: string;
    /** Hour in UTC to generate daily reports (0-23) */
    reportTimeUtcHour: number;
  };

  /** Authentication configuration */
  auth: {
    /** Auth provider: "none" for open access, "cloudflare-access" for SSO, "password" for admin password */
    provider: "none" | "cloudflare-access" | "password";
    /** Cloudflare Access team domain (required if provider is "cloudflare-access") */
    teamDomain?: string;
    /** Superadmin email — this user gets full access (connections, exec agents, role management) */
    superadminEmail?: string;
  };

  /** GitHub repo for code-watching agents (optional) */
  github?: {
    /** GitHub repo in "owner/repo" format */
    repo: string;
  };

  /**
   * Per-agent overrides — deployment-specific configuration.
   *
   * Channel filters tell agents which Slack/Discord channels to focus on.
   * These are org-specific and should NOT go in agent JSON definitions
   * (which are generic and open-source). Instead, configure them here
   * and the seed script merges them into subscriptions at seed time.
   */
  agents?: {
    /**
     * Map of agent ID → list of channel names to focus on.
     * Applied as a scopeFilter.project on the agent's Slack subscription.
     *
     * Example:
     * ```
     * channelFilters: {
     *   "cfo": ["#finance", "#operations", "#general"],
     *   "bizdev": ["#partnerships", "#general"],
     * }
     * ```
     */
    channelFilters?: Record<string, string[]>;
  };

  /** Which connectors to enable */
  connectors: {
    [key: string]: {
      enabled: boolean;
    };
  };
}
