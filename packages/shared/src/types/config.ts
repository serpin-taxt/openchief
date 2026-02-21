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
  };

  /** GitHub repo for code-watching agents (optional) */
  github?: {
    /** GitHub repo in "owner/repo" format */
    repo: string;
  };

  /** Which connectors to enable */
  connectors: {
    [key: string]: {
      enabled: boolean;
    };
  };
}
