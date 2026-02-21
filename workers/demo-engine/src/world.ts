/**
 * World state -- the fictional company and its team members.
 *
 * "Greenfield Labs" is a 15-person startup building a developer platform.
 * The team uses GitHub, Slack, Jira, Discord (community), Figma, Intercom,
 * and tracks metrics in Amplitude + Google Analytics.
 */

// -- Team members ---------------------------------------------------------------

export interface TeamMember {
  name: string;
  github: string;
  slack: string;
  role: string;
  team: string;
}

export const TEAM: TeamMember[] = [
  { name: "Maya Chen", github: "mayachen", slack: "maya", role: "Engineering Manager", team: "engineering" },
  { name: "Liam O'Brien", github: "liamob", slack: "liam", role: "Senior Backend Engineer", team: "engineering" },
  { name: "Priya Sharma", github: "priyasharma", slack: "priya", role: "Senior Frontend Engineer", team: "engineering" },
  { name: "Jordan Kim", github: "jordankim", slack: "jordan", role: "Backend Engineer", team: "engineering" },
  { name: "Sam Nakamura", github: "samnaka", slack: "sam", role: "DevOps / SRE", team: "engineering" },
  { name: "Alex Rivera", github: "arivera", slack: "alex", role: "Full-Stack Engineer", team: "engineering" },
  { name: "Nina Patel", github: "ninapatel", slack: "nina", role: "Product Manager", team: "product" },
  { name: "Carlos Mendez", github: "carlosmendez", slack: "carlos", role: "Designer", team: "design" },
  { name: "Emma Walsh", github: "emmawalsh", slack: "emma", role: "Head of Marketing", team: "marketing" },
  { name: "David Park", github: "dpark", slack: "david", role: "Data Analyst", team: "product" },
  { name: "Rachel Torres", github: "rtorres", slack: "rachel", role: "Customer Support Lead", team: "support" },
  { name: "Ben Foster", github: "bfoster", slack: "ben", role: "Community Manager", team: "community" },
  { name: "Olivia Zhang", github: "ozhang", slack: "olivia", role: "CISO / Security", team: "engineering" },
  { name: "Tom Bradley", github: "tbradley", slack: "tom", role: "CFO", team: "finance" },
  { name: "Lisa Huang", github: "lisahuang", slack: "lisa", role: "CEO", team: "leadership" },
];

// -- Company constants ----------------------------------------------------------

export const ORG = "greenfield-labs";
export const REPO = "greenfield-labs/platform";
export const SLACK_WORKSPACE = "greenfield";
export const DISCORD_SERVER = "greenfield-community";
export const JIRA_PROJECT = "GFLD";

// -- Channels -------------------------------------------------------------------

export const SLACK_CHANNELS = [
  "#engineering", "#product", "#general", "#design", "#marketing",
  "#support", "#incidents", "#deploys", "#random", "#leadership",
];

export const DISCORD_CHANNELS = [
  "general", "feedback", "bug-reports", "feature-requests",
  "announcements", "show-and-tell",
];

// -- Active work items (rotate over time) --------------------------------------

export const PR_TITLES = [
  "Add rate limiting to public API endpoints",
  "Migrate auth service to OAuth 2.1",
  "Fix memory leak in WebSocket handler",
  "Implement team permissions model",
  "Add dark mode support to dashboard",
  "Refactor database connection pooling",
  "Add CSV export for analytics reports",
  "Upgrade to Node 22 LTS",
  "Fix pagination bug in search results",
  "Add webhook retry with exponential backoff",
  "Implement API key rotation flow",
  "Add Prometheus metrics endpoint",
  "Fix CORS headers for subdomain auth",
  "Add bulk import for user accounts",
  "Implement SSO with SAML 2.0",
  "Add real-time notifications via SSE",
  "Fix timezone handling in scheduling module",
  "Refactor billing service to support usage-based pricing",
  "Add end-to-end encryption for file uploads",
  "Implement GraphQL subscriptions",
];

export const JIRA_TICKETS = [
  { key: "GFLD-301", title: "API response times exceeding SLA", type: "bug", priority: "high" },
  { key: "GFLD-302", title: "Add SSO support for enterprise customers", type: "story", priority: "high" },
  { key: "GFLD-303", title: "Dashboard loading slowly on mobile", type: "bug", priority: "medium" },
  { key: "GFLD-304", title: "Implement usage-based billing", type: "epic", priority: "high" },
  { key: "GFLD-305", title: "Add audit log for admin actions", type: "story", priority: "medium" },
  { key: "GFLD-306", title: "Fix file upload timeout on large files", type: "bug", priority: "high" },
  { key: "GFLD-307", title: "Design new onboarding flow", type: "story", priority: "medium" },
  { key: "GFLD-308", title: "Add two-factor authentication", type: "story", priority: "high" },
  { key: "GFLD-309", title: "Improve error messages in API responses", type: "task", priority: "low" },
  { key: "GFLD-310", title: "Set up staging environment", type: "task", priority: "medium" },
];

// -- Community members (external, not on the team) -----------------------------

export const COMMUNITY_MEMBERS = [
  "devuser42", "codemaster_99", "sarah_builds", "rustfan2024",
  "api_explorer", "cloud_native_dan", "fullstack_fia", "opensrc_ollie",
  "hackernight", "ux_unicorn", "byte_ninja", "ml_marcus",
];

// -- Intercom customers --------------------------------------------------------

export const CUSTOMERS = [
  { name: "Acme Corp", plan: "enterprise", contact: "jane@acmecorp.com" },
  { name: "Startup Valley", plan: "pro", contact: "mike@startupvalley.io" },
  { name: "DataFlow Inc", plan: "enterprise", contact: "sarah@dataflow.com" },
  { name: "CloudNine Studios", plan: "pro", contact: "alex@cloudnine.dev" },
  { name: "TechBridge", plan: "starter", contact: "info@techbridge.co" },
  { name: "NovaSoft", plan: "pro", contact: "support@novasoft.io" },
];

// -- Helpers -------------------------------------------------------------------

/** Pick a random element from an array. */
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Pick N random unique elements from an array. */
export function pickN<T>(arr: readonly T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

/** Random integer between min and max (inclusive). */
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Random float between min and max. */
export function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/** Generate a timestamp offset from now by the given minutes range. */
export function recentTimestamp(minMinutesAgo: number, maxMinutesAgo: number): string {
  const offset = randInt(minMinutesAgo, maxMinutesAgo) * 60 * 1000;
  return new Date(Date.now() - offset).toISOString();
}
