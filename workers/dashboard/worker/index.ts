import { generateULID } from "@openchief/shared";
import type {
  AgentDefinition,
  AgentReport,
  AgentRevision,
  EventSubscription,
} from "@openchief/shared";

// ---------------------------------------------------------------------------
// Env bindings
// ---------------------------------------------------------------------------

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  AGENT_RUNTIME: Fetcher;
  ASSETS: Fetcher;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  /** Admin password for password-based auth (set via `wrangler secret put`) */
  ADMIN_PASSWORD?: string;
  /** Auth provider: "none" | "cloudflare-access" | "password" (set via wrangler vars) */
  AUTH_PROVIDER?: string;
  /** Cloudflare Access team domain (e.g. "your-team.cloudflareaccess.com") — used for login redirect */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** When "true", the dashboard is read-only (demo mode). Write endpoints return 403. */
  DEMO_MODE?: string;
  /** Organization name for branding (set via wrangler vars from openchief.config.ts) */
  ORG_NAME?: string;
  /** Superadmin email — this user gets full access (connections, exec agents, role management) */
  SUPERADMIN_EMAIL?: string;
  /** UTC hour when daily reports are scheduled (e.g. "14" for 2pm UTC). Used for "next run" display. */
  REPORT_TIME_UTC_HOUR?: string;
  /** IANA timezone for report display (e.g. "America/Chicago"). */
  REPORT_TIMEZONE?: string;
  /** Connector service bindings — one per enabled connector (e.g. CONNECTOR_SLACK, CONNECTOR_GITHUB) */
  [key: `CONNECTOR_${string}`]: Fetcher | undefined;
}

// ---------------------------------------------------------------------------
// Connector config registry
// ---------------------------------------------------------------------------

interface ConnectorField {
  name: string;
  label: string;
  secret: boolean;
  placeholder?: string;
}

interface ConnectorConfig {
  /** Display name shown in the dashboard */
  displayName: string;
  /** Cloudflare Worker name for this connector */
  workerName: string;
  /** Configuration fields (env vars / secrets) the user must set */
  fields: ConnectorField[];
}

const CONNECTOR_CONFIGS: Record<string, ConnectorConfig> = {
  github: {
    displayName: "GitHub",
    workerName: "openchief-connector-github",
    fields: [
      { name: "GITHUB_APP_ID", label: "GitHub App ID", secret: false },
      {
        name: "GITHUB_APP_PRIVATE_KEY",
        label: "GitHub App Private Key",
        secret: true,
        placeholder: "-----BEGIN PRIVATE KEY-----...",
      },
      {
        name: "GITHUB_INSTALLATION_ID",
        label: "Installation ID",
        secret: false,
      },
      {
        name: "GITHUB_WEBHOOK_SECRET",
        label: "Webhook Secret",
        secret: true,
      },
      {
        name: "GITHUB_REPOS",
        label: "Repos (comma-separated)",
        secret: false,
        placeholder: "org/repo1,org/repo2",
      },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  slack: {
    displayName: "Slack",
    workerName: "openchief-connector-slack",
    fields: [
      { name: "SLACK_BOT_TOKEN", label: "Bot Token", secret: true, placeholder: "xoxb-..." },
      { name: "SLACK_SIGNING_SECRET", label: "Signing Secret", secret: true },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  discord: {
    displayName: "Discord",
    workerName: "openchief-connector-discord",
    fields: [
      { name: "DISCORD_BOT_TOKEN", label: "Bot Token", secret: true },
      { name: "DISCORD_PUBLIC_KEY", label: "Public Key", secret: false },
      { name: "DISCORD_GUILD_ID", label: "Guild ID", secret: false },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  figma: {
    displayName: "Figma",
    workerName: "openchief-connector-figma",
    fields: [
      { name: "FIGMA_TOKEN", label: "Personal Access Token", secret: true },
      { name: "FIGMA_PASSCODE", label: "Webhook Passcode", secret: true },
      {
        name: "FIGMA_TEAM_ID",
        label: "Team ID",
        secret: false,
        placeholder: "From your Figma team URL",
        description: "Find at figma.com/files/team/{TEAM_ID}/...",
      },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  amplitude: {
    displayName: "Amplitude",
    workerName: "openchief-connector-amplitude",
    fields: [
      { name: "AMPLITUDE_API_KEY", label: "API Key", secret: true },
      { name: "AMPLITUDE_SECRET_KEY", label: "Secret Key", secret: true },
      { name: "AMPLITUDE_PROJECT_NAME", label: "Project Name", secret: false },
    ],
  },
  intercom: {
    displayName: "Intercom",
    workerName: "openchief-connector-intercom",
    fields: [
      { name: "INTERCOM_ACCESS_TOKEN", label: "Access Token", secret: true },
      { name: "INTERCOM_CLIENT_SECRET", label: "Client Secret", secret: true },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  twitter: {
    displayName: "Twitter / X",
    workerName: "openchief-connector-twitter",
    fields: [
      { name: "X_BEARER_TOKEN", label: "Bearer Token", secret: true },
      { name: "X_OAUTH_CLIENT_ID", label: "OAuth Client ID", secret: true },
      { name: "X_OAUTH_CLIENT_SECRET", label: "OAuth Client Secret", secret: true },
      {
        name: "X_MONITORED_ACCOUNTS",
        label: "Monitored Accounts (comma-separated)",
        secret: false,
        placeholder: "account1,account2",
      },
      {
        name: "X_SEARCH_QUERIES",
        label: "Search Queries (comma-separated)",
        secret: false,
        placeholder: '"my product",#myhashtag',
      },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  googleanalytics: {
    displayName: "Google Analytics",
    workerName: "openchief-connector-googleanalytics",
    fields: [
      {
        name: "GA4_SERVICE_ACCOUNT_KEY",
        label: "Service Account Key (JSON)",
        secret: true,
      },
      { name: "GA4_PROPERTY_ID", label: "GA4 Property ID", secret: false },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  googlecalendar: {
    displayName: "Google Calendar",
    workerName: "openchief-connector-googlecalendar",
    fields: [
      { name: "GOOGLE_CLIENT_ID", label: "OAuth Client ID", secret: true },
      { name: "GOOGLE_CLIENT_SECRET", label: "OAuth Client Secret", secret: true },
      { name: "GOOGLE_CALENDAR_ID", label: "Calendar ID", secret: false, placeholder: "primary" },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  notion: {
    displayName: "Notion",
    workerName: "openchief-connector-notion",
    fields: [
      { name: "NOTION_API_KEY", label: "Integration Token", secret: true, placeholder: "ntn_..." },
    ],
  },
  jira: {
    displayName: "Jira",
    workerName: "openchief-connector-jira",
    fields: [
      { name: "JIRA_API_EMAIL", label: "API Email", secret: false },
      { name: "JIRA_API_TOKEN", label: "API Token", secret: true },
      {
        name: "JIRA_INSTANCE_URL",
        label: "Instance URL",
        secret: false,
        placeholder: "https://yourteam.atlassian.net",
      },
      {
        name: "JIRA_PROJECTS",
        label: "Projects (comma-separated)",
        secret: false,
        placeholder: "PROJ1,PROJ2",
      },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  quickbooks: {
    displayName: "QuickBooks",
    workerName: "openchief-connector-quickbooks",
    fields: [
      { name: "QB_CLIENT_ID", label: "Client ID", secret: true },
      { name: "QB_CLIENT_SECRET", label: "Client Secret", secret: true },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  rippling: {
    displayName: "Rippling",
    workerName: "openchief-connector-rippling",
    fields: [
      { name: "RIPPLING_API_TOKEN", label: "API Token", secret: true },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
  jpd: {
    displayName: "Jira Product Discovery",
    workerName: "openchief-connector-jpd",
    fields: [
      {
        name: "JPD_API_EMAIL",
        label: "API Email",
        secret: false,
        placeholder: "you@company.com",
      },
      { name: "JPD_API_TOKEN", label: "API Token", secret: true },
      {
        name: "JPD_INSTANCE_URL",
        label: "Instance URL",
        secret: false,
        placeholder: "https://yourteam.atlassian.net",
      },
      {
        name: "JPD_PROJECTS",
        label: "JPD Projects (comma-separated)",
        secret: false,
        placeholder: "JPD1,JPD2",
      },
      { name: "ADMIN_SECRET", label: "Admin Secret", secret: true },
    ],
  },
};

// ---------------------------------------------------------------------------
// Source-to-tool mapping (for data-driven /access endpoint)
// ---------------------------------------------------------------------------

const SOURCE_TO_TOOL: Record<string, string> = {
  github: "github_file",
  database: "query_database",
  slack: "slack_search",
  discord: "discord_search",
  jira: "jira_query",
  notion: "notion_query",
  figma: "figma_data",
  amplitude: "amplitude_query",
  intercom: "intercom_data",
  twitter: "twitter_search",
  googleanalytics: "ga4_query",
  googlecalendar: "gcal_events",
  quickbooks: "quickbooks_query",
  rippling: "rippling_data",
  jpd: "jpd_query",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function errorJson(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function maskValue(value: string): string {
  if (value.length <= 8) return "••••••••";
  return value.slice(0, 4) + "••••" + value.slice(-4);
}

function detectImageType(
  buffer: ArrayBuffer
): { mime: string; ext: string } | null {
  const bytes = new Uint8Array(buffer);
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { mime: "image/gif", ext: "gif" };
  }
  // WebP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  // SVG (starts with < or whitespace then <)
  const textStart = new TextDecoder().decode(bytes.slice(0, 256)).trim();
  if (textStart.startsWith("<svg") || textStart.startsWith("<?xml")) {
    return { mime: "image/svg+xml", ext: "svg" };
  }
  return null;
}

async function loadAgentConfig(db: D1Database, agentId: string): Promise<AgentDefinition | null> {
  const row = await db
    .prepare("SELECT config FROM agent_definitions WHERE id = ?")
    .bind(agentId)
    .first<{ config: string }>();
  if (!row) return null;
  return JSON.parse(row.config) as AgentDefinition;
}

// ---------------------------------------------------------------------------
// Session cookie helpers (password auth)
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "oc_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const textEncoder = new TextEncoder();

async function createSessionToken(secret: string, email: string): Promise<string> {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = `${email}|${expiry}`;

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  const sigHex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${payload}|${sigHex}`;
}

async function verifySessionToken(
  token: string,
  secret: string,
): Promise<string | null> {
  const parts = token.split("|");
  if (parts.length !== 3) return null;

  const [email, expiryStr, sigHex] = parts;
  const expiry = parseInt(expiryStr, 10);
  if (isNaN(expiry) || Date.now() > expiry) return null;

  const payload = `${email}|${expiryStr}`;
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedSig = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(payload),
  );
  const expectedHex = [...new Uint8Array(expectedSig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expectedHex.length !== sigHex.length) return null;
  let result = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    result |= expectedHex.charCodeAt(i) ^ sigHex.charCodeAt(i);
  }
  if (result !== 0) return null;

  return email;
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) cookies[name.trim()] = rest.join("=").trim();
  }
  return cookies;
}

function sessionCookieHeader(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function getUserEmail(request: Request, env: Env): Promise<string> {
  const provider = env.AUTH_PROVIDER || "none";

  if (provider === "cloudflare-access") {
    return request.headers.get("cf-access-authenticated-user-email") || "unknown";
  }

  if (provider === "password" && env.ADMIN_PASSWORD) {
    const cookies = parseCookies(request.headers.get("Cookie"));
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const email = await verifySessionToken(token, env.ADMIN_PASSWORD);
      if (email) return email;
    }
    return "unknown";
  }

  // provider === "none" — no login, so fall back to SUPERADMIN_EMAIL if set
  // (if you're running without auth, you're presumably the admin)
  return env.SUPERADMIN_EMAIL || "unknown";
}

type UserRole = "superadmin" | "exec" | null;

async function getUserRole(email: string, env: Env): Promise<UserRole> {
  // Superadmin check — config-defined email takes priority
  if (
    env.SUPERADMIN_EMAIL &&
    email.toLowerCase() === env.SUPERADMIN_EMAIL.toLowerCase()
  ) {
    return "superadmin";
  }

  // Demo mode: grant exec so everyone sees all agents (but not superadmin)
  if (env.DEMO_MODE === "true") {
    return "exec";
  }

  // Check identity_mappings for stored role
  try {
    const row = await env.DB.prepare(
      "SELECT role FROM identity_mappings WHERE email = ? LIMIT 1",
    )
      .bind(email)
      .first<{ role: string | null }>();
    if (row?.role === "exec" || row?.role === "superadmin") {
      return row.role as UserRole;
    }
  } catch {
    // identity_mappings table may not exist yet — graceful fallback
  }

  return null;
}

function canAccessAgent(agentVisibility: string | undefined, userRole: UserRole): boolean {
  if (agentVisibility === "exec") {
    return userRole === "superadmin" || userRole === "exec";
  }
  return true;
}

function parseUrl(request: Request): URL {
  return new URL(request.url);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = parseUrl(request);
    const path = url.pathname;
    const method = request.method;

    // Only handle /api/* routes — everything else is handled by the asset server
    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      // -----------------------------------------------------------------------
      // Auth routes (always accessible, before middleware)
      // -----------------------------------------------------------------------
      if (method === "POST" && path === "/api/auth/login") {
        return handleLogin(request, env);
      }
      if (method === "POST" && path === "/api/auth/logout") {
        return handleLogout();
      }
      if (method === "GET" && path === "/api/auth/session") {
        return handleSessionCheck(request, env);
      }

      // -----------------------------------------------------------------------
      // Auth middleware
      // -----------------------------------------------------------------------
      const provider = env.AUTH_PROVIDER || "none";

      // Cloudflare Access mode — reject requests missing the identity header.
      // When CF Access is properly configured, every request through the
      // Access policy will have this header. If it's missing, the request
      // either bypassed Access or the policy isn't set up yet.
      if (provider === "cloudflare-access") {
        const cfEmail = request.headers.get("cf-access-authenticated-user-email");
        if (!cfEmail) {
          return errorJson("Unauthorized — Cloudflare Access identity missing", 401);
        }
      }

      // Password mode — verify session cookie
      if (provider === "password" && env.ADMIN_PASSWORD) {
        const cookies = parseCookies(request.headers.get("Cookie"));
        const token = cookies[SESSION_COOKIE];
        if (!token) {
          return errorJson("Unauthorized", 401);
        }
        const sessionEmail = await verifySessionToken(token, env.ADMIN_PASSWORD);
        if (!sessionEmail) {
          return errorJson("Unauthorized", 401);
        }
      }

      // -----------------------------------------------------------------------
      // Demo mode guard — block all write operations for unauthenticated users
      // -----------------------------------------------------------------------
      const isDemoMode = env.DEMO_MODE === "true";
      if (isDemoMode && (method === "POST" || method === "PUT" || method === "DELETE")) {
        // Admin sessions bypass the demo guard entirely
        let isAdmin = false;
        if (env.ADMIN_PASSWORD) {
          const cookies = parseCookies(request.headers.get("Cookie"));
          const token = cookies[SESSION_COOKIE];
          if (token) {
            isAdmin = !!(await verifySessionToken(token, env.ADMIN_PASSWORD));
          }
        }

        if (!isAdmin) {
          const isChatRequest = /^\/api\/agents\/[^/]+\/chat$/.test(path);
          if (!isChatRequest) {
            return errorJson("This is a read-only demo instance", 403);
          }
          // Rate-limit chat in demo mode: 50 messages per IP per hour
          const ip = request.headers.get("cf-connecting-ip") || "unknown";
          const rateLimitKey = `demo:chat:${ip}`;
          const current = parseInt(await env.KV.get(rateLimitKey) || "0", 10);
          if (current >= 50) {
            return errorJson("Demo chat limit reached (50 messages/hour). Deploy your own instance for unlimited access!", 429);
          }
          await env.KV.put(rateLimitKey, String(current + 1), { expirationTtl: 3600 });
        }
      }

      // -----------------------------------------------------------------------
      // GET /api/me
      // -----------------------------------------------------------------------
      if (method === "GET" && path === "/api/me") {
        return handleGetMe(request, env);
      }

      // -----------------------------------------------------------------------
      // Agents
      // -----------------------------------------------------------------------
      if (method === "GET" && path === "/api/agents") {
        return handleListAgents(request, env);
      }
      if (method === "POST" && path === "/api/agents") {
        return handleCreateAgent(request, env);
      }

      // /api/agents/:id
      const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch) {
        const agentId = decodeURIComponent(agentMatch[1]);
        if (method === "GET") return handleGetAgent(request, env, agentId);
        if (method === "PUT") return handleUpdateAgent(request, env, agentId);
      }

      // /api/agents/:id/avatar
      const avatarMatch = path.match(/^\/api\/agents\/([^/]+)\/avatar$/);
      if (avatarMatch) {
        const agentId = decodeURIComponent(avatarMatch[1]);
        if (method === "PUT") return handleUploadAvatar(request, env, agentId);
        if (method === "GET") return handleGetAvatar(request, env, agentId, ctx);
        if (method === "DELETE") return handleDeleteAvatar(request, env, agentId);
      }

      // Exec visibility guard for agent sub-endpoints
      const agentSubMatch = path.match(/^\/api\/agents\/([^/]+)\//);
      if (agentSubMatch) {
        const guardId = decodeURIComponent(agentSubMatch[1]);
        const guardConfig = await loadAgentConfig(env.DB, guardId);
        if (guardConfig) {
          const guardEmail = await getUserEmail(request, env);
          const guardRole = await getUserRole(guardEmail, env);
          if (!canAccessAgent(guardConfig.visibility, guardRole)) {
            return errorJson("Access restricted", 403);
          }
        }
      }

      // /api/agents/:id/reports
      const reportsMatch = path.match(/^\/api\/agents\/([^/]+)\/reports$/);
      if (reportsMatch && method === "GET") {
        const agentId = decodeURIComponent(reportsMatch[1]);
        return handleListReports(env, agentId);
      }

      // /api/agents/:id/reports/latest
      const latestReportMatch = path.match(/^\/api\/agents\/([^/]+)\/reports\/latest$/);
      if (latestReportMatch && method === "GET") {
        const agentId = decodeURIComponent(latestReportMatch[1]);
        return handleGetLatestReport(env, agentId);
      }

      // /api/agents/:id/reports/:reportId
      const reportDetailMatch = path.match(/^\/api\/agents\/([^/]+)\/reports\/([^/]+)$/);
      if (reportDetailMatch && method === "GET") {
        const agentId = decodeURIComponent(reportDetailMatch[1]);
        const reportId = decodeURIComponent(reportDetailMatch[2]);
        return handleGetReport(env, agentId, reportId);
      }

      // /api/agents/:id/revisions
      const revisionsMatch = path.match(/^\/api\/agents\/([^/]+)\/revisions$/);
      if (revisionsMatch && method === "GET") {
        const agentId = decodeURIComponent(revisionsMatch[1]);
        return handleListRevisions(env, agentId);
      }

      // /api/agents/:id/chat
      const chatMatch = path.match(/^\/api\/agents\/([^/]+)\/chat$/);
      if (chatMatch && method === "POST") {
        const agentId = decodeURIComponent(chatMatch[1]);
        return handleChat(request, env, agentId);
      }

      // /api/agents/:id/chat/history
      const chatHistoryMatch = path.match(/^\/api\/agents\/([^/]+)\/chat\/history$/);
      if (chatHistoryMatch && method === "GET") {
        const agentId = decodeURIComponent(chatHistoryMatch[1]);
        return handleChatHistory(request, env, agentId);
      }

      // /api/agents/:id/events/volume
      const eventsVolumeMatch = path.match(/^\/api\/agents\/([^/]+)\/events\/volume$/);
      if (eventsVolumeMatch && method === "GET") {
        const agentId = decodeURIComponent(eventsVolumeMatch[1]);
        return handleEventsVolume(request, env, agentId);
      }

      // /api/agents/:id/trigger/:reportType
      const triggerMatch = path.match(/^\/api\/agents\/([^/]+)\/trigger\/([^/]+)$/);
      if (triggerMatch && method === "POST") {
        const agentId = decodeURIComponent(triggerMatch[1]);
        const reportType = decodeURIComponent(triggerMatch[2]);
        return handleTrigger(request, env, agentId, reportType);
      }

      // -----------------------------------------------------------------------
      // Connections (superadmin only)
      // -----------------------------------------------------------------------

      // Gate all /api/connections/* routes behind superadmin role
      if (path.startsWith("/api/connections")) {
        const connEmail = await getUserEmail(request, env);
        const connRole = await getUserRole(connEmail, env);
        if (connRole !== "superadmin") {
          return errorJson("Superadmin access required", 403);
        }
      }

      if (method === "GET" && path === "/api/connections") {
        return handleListConnections(env);
      }

      // /api/connections/:source/settings
      const connSettingsMatch = path.match(/^\/api\/connections\/([^/]+)\/settings$/);
      if (connSettingsMatch) {
        const source = decodeURIComponent(connSettingsMatch[1]);
        if (method === "GET") return handleGetConnectionSettings(env, source);
        if (method === "PUT") return handleUpdateConnectionSettings(request, env, source);
      }

      // /api/connections/:source/events
      const connEventsMatch = path.match(/^\/api\/connections\/([^/]+)\/events$/);
      if (connEventsMatch && method === "GET") {
        const source = decodeURIComponent(connEventsMatch[1]);
        return handleGetConnectionEvents(env, source);
      }

      // /api/connections/:source/stats
      const connStatsMatch = path.match(/^\/api\/connections\/([^/]+)\/stats$/);
      if (connStatsMatch && method === "GET") {
        const source = decodeURIComponent(connStatsMatch[1]);
        return handleGetConnectionStats(env, source);
      }

      // /api/connections/:source/access
      const connAccessMatch = path.match(/^\/api\/connections\/([^/]+)\/access$/);
      if (connAccessMatch && method === "GET") {
        const source = decodeURIComponent(connAccessMatch[1]);
        return handleGetConnectionAccess(env, source);
      }

      // /api/connections/:source/sync  (trigger connector poll)
      const connSyncMatch = path.match(/^\/api\/connections\/([^/]+)\/sync$/);
      if (connSyncMatch && method === "POST") {
        const source = decodeURIComponent(connSyncMatch[1]);
        return handleConnectionSync(request, env, source);
      }

      // /api/connections/:source/projects  (list + save selected projects)
      const connProjectsMatch = path.match(/^\/api\/connections\/([^/]+)\/projects$/);
      if (connProjectsMatch) {
        const source = decodeURIComponent(connProjectsMatch[1]);
        if (method === "GET") return handleGetConnectionProjects(env, source);
        if (method === "PUT") return handleUpdateConnectionProjects(request, env, source);
      }

      // -----------------------------------------------------------------------
      // Identities
      // -----------------------------------------------------------------------
      if (method === "GET" && path === "/api/identities") {
        return handleListIdentities(env);
      }
      if (method === "POST" && path === "/api/identities/merge") {
        return handleMergeIdentities(request, env);
      }

      // PUT /api/identities/:id/role (superadmin only)
      const identityRoleMatch = path.match(/^\/api\/identities\/([^/]+)\/role$/);
      if (identityRoleMatch && method === "PUT") {
        const identityId = decodeURIComponent(identityRoleMatch[1]);
        return handleUpdateIdentityRole(request, env, identityId);
      }

      // PUT /api/identities/:id/active (superadmin only)
      const identityActiveMatch = path.match(/^\/api\/identities\/([^/]+)\/active$/);
      if (identityActiveMatch && method === "PUT") {
        const identityId = decodeURIComponent(identityActiveMatch[1]);
        return handleUpdateIdentityActive(request, env, identityId);
      }

      // -----------------------------------------------------------------------
      // Jobs
      // -----------------------------------------------------------------------
      if (method === "GET" && path === "/api/jobs/status") {
        return handleJobsStatus(request, env);
      }

      // -----------------------------------------------------------------------
      // Models
      // -----------------------------------------------------------------------
      if (method === "GET" && path === "/api/models") {
        return handleListModels(env);
      }

      const modelsMatch = path.match(/^\/api\/models\/([^/]+)$/);
      if (modelsMatch && method === "PUT") {
        const jobType = decodeURIComponent(modelsMatch[1]);
        return handleUpdateModel(request, env, jobType);
      }

      // -----------------------------------------------------------------------
      // Tasks
      // -----------------------------------------------------------------------

      if (method === "GET" && path === "/api/tasks/stats") {
        return handleTaskStats(env);
      }

      if (method === "GET" && path === "/api/tasks") {
        return handleListTasks(request, env);
      }

      if (method === "POST" && path === "/api/tasks") {
        return handleCreateTask(request, env);
      }

      const taskDetailMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskDetailMatch && method === "GET") {
        return handleGetTask(env, decodeURIComponent(taskDetailMatch[1]));
      }
      if (taskDetailMatch && method === "PUT") {
        return handleUpdateTask(request, env, decodeURIComponent(taskDetailMatch[1]));
      }

      // -----------------------------------------------------------------------
      // Tools (superadmin only)
      // -----------------------------------------------------------------------

      if (path.startsWith("/api/tools")) {
        const toolsEmail = await getUserEmail(request, env);
        const toolsRole = await getUserRole(toolsEmail, env);
        if (toolsRole !== "superadmin") {
          return errorJson("Superadmin access required", 403);
        }
      }

      if (method === "GET" && path === "/api/tools/slack-message-counts") {
        return handleSlackMessageCounts(env);
      }

      if (method === "POST" && path === "/api/tools/refresh-slack") {
        return handleRefreshSlack(env);
      }

      if (method === "POST" && path === "/api/tools/generate-voice") {
        return handleGenerateVoice(request, env);
      }

      // -----------------------------------------------------------------------
      // 404
      // -----------------------------------------------------------------------
      return errorJson("Not found", 404);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error("API error:", err);
      return errorJson(message, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// ===========================================================================
// Route implementations
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/me
// ---------------------------------------------------------------------------
async function handleGetMe(request: Request, env: Env): Promise<Response> {
  const email = await getUserEmail(request, env);

  let displayName: string | null = null;
  let avatarUrl: string | null = null;
  let team: string | null = null;

  try {
    const identity = await env.DB.prepare(
      "SELECT display_name, avatar_url, team FROM identity_mappings WHERE email = ? LIMIT 1"
    )
      .bind(email)
      .first<{ display_name: string; avatar_url: string; team: string }>();

    if (identity) {
      displayName = identity.display_name;
      avatarUrl = identity.avatar_url;
      team = identity.team;
    }
  } catch {
    // identity_mappings table may not exist yet — graceful fallback
  }

  // Resolve role via getUserRole (checks SUPERADMIN_EMAIL + identity_mappings)
  const resolvedRole = await getUserRole(email, env);

  return json({
    email,
    displayName: displayName || email.split("@")[0],
    avatarUrl,
    team,
    role: resolvedRole,
  });
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    return errorJson("Password auth not enabled", 400);
  }

  let body: { password?: string; email?: string };
  try {
    body = (await request.json()) as { password?: string; email?: string };
  } catch {
    return errorJson("Invalid request body", 400);
  }

  if (!body.password) {
    return errorJson("Password required", 400);
  }

  if (!body.email) {
    return errorJson("Email required", 400);
  }

  // Constant-time comparison
  const expected = env.ADMIN_PASSWORD;
  const actual = body.password;
  if (expected.length !== actual.length) {
    return errorJson("Invalid password", 401);
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  if (mismatch !== 0) {
    return errorJson("Invalid password", 401);
  }

  const loginEmail = body.email.toLowerCase().trim();
  const token = await createSessionToken(env.ADMIN_PASSWORD, loginEmail);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);

  return json(
    { ok: true },
    200,
    { "Set-Cookie": sessionCookieHeader(token, maxAge) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
function handleLogout(): Response {
  return json(
    { ok: true },
    200,
    { "Set-Cookie": sessionCookieHeader("deleted", 0) },
  );
}

// ---------------------------------------------------------------------------
// GET /api/auth/session
// ---------------------------------------------------------------------------
async function handleSessionCheck(request: Request, env: Env): Promise<Response> {
  const provider = env.AUTH_PROVIDER || "none";
  const demoMode = env.DEMO_MODE === "true";
  const orgName = env.ORG_NAME || null;

  if (provider === "none") {
    // In demo mode with ADMIN_PASSWORD set, check for admin session
    let isAdmin = false;
    if (demoMode && env.ADMIN_PASSWORD) {
      const cookies = parseCookies(request.headers.get("Cookie"));
      const token = cookies[SESSION_COOKIE];
      if (token) {
        isAdmin = !!(await verifySessionToken(token, env.ADMIN_PASSWORD));
      }
    }
    // Resolve role so the sidebar can show exec agents and connections
    const email = await getUserEmail(request, env);
    const role = await getUserRole(email, env);
    return json({ authenticated: true, provider: "none", demoMode, isAdmin, orgName, role });
  }

  if (provider === "cloudflare-access") {
    const email = request.headers.get("cf-access-authenticated-user-email");
    let role: UserRole = null;
    if (email) {
      role = await getUserRole(email, env);
    }
    return json({
      authenticated: !!email,
      provider: "cloudflare-access",
      email: email || null,
      role,
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN || null,
      demoMode,
      orgName,
    });
  }

  if (provider === "password" && env.ADMIN_PASSWORD) {
    const cookies = parseCookies(request.headers.get("Cookie"));
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const email = await verifySessionToken(token, env.ADMIN_PASSWORD);
      if (email) {
        const role = await getUserRole(email, env);
        return json({ authenticated: true, provider: "password", email, role, demoMode, orgName });
      }
    }
    return json({ authenticated: false, provider: "password", demoMode, orgName });
  }

  return json({ authenticated: true, provider: "none", demoMode, orgName });
}

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------
async function handleListAgents(request: Request, env: Env): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const userRole = await getUserRole(userEmail, env);
  const { results } = await env.DB.prepare(
    "SELECT id, config FROM agent_definitions WHERE json_extract(config, '$.enabled') = true ORDER BY id"
  ).all<{ id: string; config: string }>();

  const agents = await Promise.all(
    (results || []).map(async (row) => {
      const config = JSON.parse(row.config) as AgentDefinition;
      // Check for avatar in KV (include content hash for cache busting)
      const avatarMeta = await env.KV.getWithMetadata<{ contentType?: string; size?: number }>(`avatar:${row.id}`);
      const hasAvatar = avatarMeta.value !== null;
      const avatarVersion = avatarMeta.metadata?.size || Date.now();
      return {
        ...config,
        avatarUrl: hasAvatar ? `/api/agents/${row.id}/avatar?v=${avatarVersion}` : null,
      };
    })
  );

  // Filter out exec agents the user can't access (role-based)
  const filtered = agents.filter((a) => canAccessAgent(a.visibility, userRole));

  return json(filtered);
}

// ---------------------------------------------------------------------------
// POST /api/agents
// ---------------------------------------------------------------------------
async function handleCreateAgent(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as AgentDefinition & { changeNote?: string };
  const email = await getUserEmail(request, env);

  if (!body.id || !body.name) {
    return errorJson("id and name are required");
  }

  // Check for duplicate
  const existing = await env.DB.prepare(
    "SELECT id FROM agent_definitions WHERE id = ?"
  )
    .bind(body.id)
    .first();
  if (existing) {
    return errorJson("Agent with this ID already exists", 409);
  }

  const config: AgentDefinition = {
    id: body.id,
    name: body.name,
    description: body.description || "",
    subscriptions: body.subscriptions || [],
    persona: body.persona || {
      role: "",
      instructions: "",
      watchPatterns: [],
      outputStyle: "",
    },
    outputs: body.outputs || { reports: [] },
    enabled: body.enabled !== false,
    tools: body.tools || [],
  };

  const configJson = JSON.stringify(config);
  const revisionId = generateULID();
  const now = new Date().toISOString();

  const batch = [
    env.DB.prepare(
      "INSERT INTO agent_definitions (id, config, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind(body.id, configJson, now, now),
  ];

  // Insert subscriptions
  for (const sub of config.subscriptions) {
    batch.push(
      env.DB.prepare(
        "INSERT INTO agent_subscriptions (agent_id, source, event_types, scope_filter) VALUES (?, ?, ?, ?)"
      ).bind(
        body.id,
        sub.source,
        JSON.stringify(sub.eventTypes),
        sub.scopeFilter ? JSON.stringify(sub.scopeFilter) : null
      )
    );
  }

  // Create initial revision
  const revision: AgentRevision = {
    id: revisionId,
    agentId: body.id,
    config,
    changedBy: email,
    changeNote: body.changeNote || "Initial creation",
    createdAt: now,
  };

  batch.push(
    env.DB.prepare(
      "INSERT INTO agent_revisions (id, agent_id, config, changed_by, change_note, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      revisionId,
      body.id,
      configJson,
      email,
      revision.changeNote,
      now
    )
  );

  await env.DB.batch(batch);

  // Invalidate subscriptions cache
  await env.KV.delete("subscriptions:all");

  return json(config, 201);
}

// ---------------------------------------------------------------------------
// GET /api/agents/:id
// ---------------------------------------------------------------------------
async function handleGetAgent(request: Request, env: Env, agentId: string): Promise<Response> {
  const config = await loadAgentConfig(env.DB, agentId);
  if (!config) return errorJson("Agent not found", 404);

  // Enforce exec visibility
  const userEmail = await getUserEmail(request, env);
  if (!canAccessAgent(config, userEmail)) {
    return errorJson("Access restricted", 403);
  }

  // Check for avatar (include content hash for cache busting)
  const avatarMeta = await env.KV.getWithMetadata<{ contentType?: string; size?: number }>(`avatar:${agentId}`);
  const hasAvatar = avatarMeta.value !== null;
  const avatarVersion = avatarMeta.metadata?.size || Date.now();

  return json({
    ...config,
    avatarUrl: hasAvatar ? `/api/agents/${agentId}/avatar?v=${avatarVersion}` : null,
  });
}

// ---------------------------------------------------------------------------
// PUT /api/agents/:id
// ---------------------------------------------------------------------------
async function handleUpdateAgent(
  request: Request,
  env: Env,
  agentId: string
): Promise<Response> {
  const existing = await loadAgentConfig(env.DB, agentId);
  if (!existing) return errorJson("Agent not found", 404);

  const body = (await request.json()) as Partial<AgentDefinition> & { changeNote?: string };
  const email = await getUserEmail(request, env);

  const updated: AgentDefinition = {
    ...existing,
    ...body,
    id: agentId, // Prevent ID change
  };

  const configJson = JSON.stringify(updated);
  const revisionId = generateULID();
  const now = new Date().toISOString();

  const batch: D1PreparedStatement[] = [
    env.DB.prepare(
      "UPDATE agent_definitions SET config = ?, updated_at = ? WHERE id = ?"
    ).bind(configJson, now, agentId),

    // Replace subscriptions
    env.DB.prepare("DELETE FROM agent_subscriptions WHERE agent_id = ?").bind(agentId),
  ];

  for (const sub of updated.subscriptions) {
    batch.push(
      env.DB.prepare(
        "INSERT INTO agent_subscriptions (agent_id, source, event_types, scope_filter) VALUES (?, ?, ?, ?)"
      ).bind(
        agentId,
        sub.source,
        JSON.stringify(sub.eventTypes),
        sub.scopeFilter ? JSON.stringify(sub.scopeFilter) : null
      )
    );
  }

  // Create revision
  batch.push(
    env.DB.prepare(
      "INSERT INTO agent_revisions (id, agent_id, config, changed_by, change_note, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      revisionId,
      agentId,
      configJson,
      email,
      body.changeNote || "Configuration updated",
      now
    )
  );

  await env.DB.batch(batch);

  // Invalidate caches
  await env.KV.delete("subscriptions:all");

  return json(updated);
}

// ---------------------------------------------------------------------------
// PUT /api/agents/:id/avatar
// ---------------------------------------------------------------------------
async function handleUploadAvatar(
  request: Request,
  env: Env,
  agentId: string
): Promise<Response> {
  const config = await loadAgentConfig(env.DB, agentId);
  if (!config) return errorJson("Agent not found", 404);

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > 5 * 1024 * 1024) {
    return errorJson("Avatar must be under 5MB", 413);
  }
  if (buffer.byteLength === 0) {
    return errorJson("Empty file", 400);
  }

  const imageType = detectImageType(buffer);
  if (!imageType) {
    return errorJson("Unsupported image format. Use PNG, JPEG, GIF, WebP, or SVG.", 415);
  }

  await env.KV.put(`avatar:${agentId}`, buffer, {
    metadata: { contentType: imageType.mime, size: buffer.byteLength },
  });

  return json({ ok: true, contentType: imageType.mime, size: buffer.byteLength });
}

// ---------------------------------------------------------------------------
// GET /api/agents/:id/avatar
// ---------------------------------------------------------------------------
async function handleGetAvatar(
  request: Request,
  env: Env,
  agentId: string,
  ctx: ExecutionContext
): Promise<Response> {
  // Try CF edge cache first (keyed on full URL including ?v= param)
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const { value, metadata } = await env.KV.getWithMetadata<{ contentType: string }>(
    `avatar:${agentId}`,
    { type: "arrayBuffer" }
  );

  if (!value) {
    return errorJson("No avatar found", 404);
  }

  const response = new Response(value as ArrayBuffer, {
    headers: {
      "Content-Type": metadata?.contentType || "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });

  // Store in edge cache (non-blocking)
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

// ---------------------------------------------------------------------------
// DELETE /api/agents/:id/avatar
// ---------------------------------------------------------------------------
async function handleDeleteAvatar(
  request: Request,
  env: Env,
  agentId: string
): Promise<Response> {
  await env.KV.delete(`avatar:${agentId}`);

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// GET /api/agents/:id/reports
// ---------------------------------------------------------------------------
async function handleListReports(env: Env, agentId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, agent_id, report_type, content, event_count, created_at
     FROM reports
     WHERE agent_id = ?
     ORDER BY created_at DESC
     LIMIT 50`
  )
    .bind(agentId)
    .all<{
      id: string;
      agent_id: string;
      report_type: string;
      content: string;
      event_count: number;
      created_at: string;
    }>();

  const reports: AgentReport[] = (results || []).map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    reportType: row.report_type,
    content: JSON.parse(row.content),
    eventCount: row.event_count,
    createdAt: row.created_at,
  }));

  return json(reports);
}

// ---------------------------------------------------------------------------
// GET /api/agents/:id/reports/latest
// ---------------------------------------------------------------------------
async function handleGetLatestReport(env: Env, agentId: string): Promise<Response> {
  // Try KV cache first
  const cacheKey = `report:${agentId}:latest`;
  const cached = await env.KV.get(cacheKey, { type: "text" });
  if (cached) {
    return new Response(cached, {
      headers: { "Content-Type": "application/json" },
    });
  }

  const row = await env.DB.prepare(
    `SELECT id, agent_id, report_type, content, event_count, created_at
     FROM reports
     WHERE agent_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(agentId)
    .first<{
      id: string;
      agent_id: string;
      report_type: string;
      content: string;
      event_count: number;
      created_at: string;
    }>();

  if (!row) return errorJson("No reports found", 404);

  const report: AgentReport = {
    id: row.id,
    agentId: row.agent_id,
    reportType: row.report_type,
    content: JSON.parse(row.content),
    eventCount: row.event_count,
    createdAt: row.created_at,
  };

  const responseBody = JSON.stringify(report);

  // Cache in KV for 5 minutes
  await env.KV.put(cacheKey, responseBody, { expirationTtl: 300 });

  return new Response(responseBody, {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /api/agents/:id/reports/:reportId
// ---------------------------------------------------------------------------
async function handleGetReport(
  env: Env,
  agentId: string,
  reportId: string
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, agent_id, report_type, content, event_count, created_at
     FROM reports
     WHERE id = ? AND agent_id = ?`
  )
    .bind(reportId, agentId)
    .first<{
      id: string;
      agent_id: string;
      report_type: string;
      content: string;
      event_count: number;
      created_at: string;
    }>();

  if (!row) return errorJson("Report not found", 404);

  const report: AgentReport = {
    id: row.id,
    agentId: row.agent_id,
    reportType: row.report_type,
    content: JSON.parse(row.content),
    eventCount: row.event_count,
    createdAt: row.created_at,
  };

  return json(report);
}

// ---------------------------------------------------------------------------
// GET /api/agents/:id/revisions
// ---------------------------------------------------------------------------
async function handleListRevisions(env: Env, agentId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, agent_id, config, changed_by, change_note, created_at
     FROM agent_revisions
     WHERE agent_id = ?
     ORDER BY created_at DESC
     LIMIT 50`
  )
    .bind(agentId)
    .all<{
      id: string;
      agent_id: string;
      config: string;
      changed_by: string;
      change_note: string;
      created_at: string;
    }>();

  const revisions: AgentRevision[] = (results || []).map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    config: JSON.parse(row.config),
    changedBy: row.changed_by,
    changeNote: row.change_note,
    createdAt: row.created_at,
  }));

  return json(revisions);
}

// ---------------------------------------------------------------------------
// POST /api/agents/:id/chat
// ---------------------------------------------------------------------------
async function handleChat(
  request: Request,
  env: Env,
  agentId: string
): Promise<Response> {
  const userEmail = await getUserEmail(request, env);

  // Resolve display name from identity mappings
  let userName = userEmail.split("@")[0];
  try {
    const identity = await env.DB.prepare(
      "SELECT display_name FROM identity_mappings WHERE email = ? LIMIT 1"
    )
      .bind(userEmail)
      .first<{ display_name: string }>();
    if (identity?.display_name) {
      userName = identity.display_name;
    }
  } catch {
    // graceful fallback
  }

  // Parse the frontend payload and transform for the runtime
  const rawBody = (await request.json()) as { messages?: { role: string; content: string }[]; message?: string };

  // The frontend sends { messages: [...] } but the runtime expects { message: string }
  let message: string;
  if (rawBody.message) {
    message = rawBody.message;
  } else if (rawBody.messages && rawBody.messages.length > 0) {
    // Extract the last user message from the conversation array
    const lastUserMsg = [...rawBody.messages].reverse().find((m) => m.role === "user");
    message = lastUserMsg?.content || "";
  } else {
    return errorJson("message is required", 400);
  }

  // Proxy to AGENT_RUNTIME with SSE streaming
  const runtimeUrl = `https://openchief-runtime/chat/${agentId}`;
  const runtimeResponse = await env.AGENT_RUNTIME.fetch(runtimeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, userEmail, userName }),
  });

  // Stream the SSE response through
  return new Response(runtimeResponse.body, {
    status: runtimeResponse.status,
    headers: {
      "Content-Type": runtimeResponse.headers.get("Content-Type") || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/agents/:id/chat/history
// ---------------------------------------------------------------------------
async function handleChatHistory(
  request: Request,
  env: Env,
  agentId: string
): Promise<Response> {
  const userEmail = await getUserEmail(request, env);
  const runtimeUrl = `https://openchief-runtime/chat/${agentId}/history?email=${encodeURIComponent(userEmail)}`;

  const runtimeResponse = await env.AGENT_RUNTIME.fetch(runtimeUrl, {
    method: "GET",
    headers: {
      "X-User-Email": userEmail,
    },
  });

  const data = await runtimeResponse.text();
  return new Response(data, {
    status: runtimeResponse.status,
    headers: {
      "Content-Type": runtimeResponse.headers.get("Content-Type") || "application/json",
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/agents/:id/events/volume
// ---------------------------------------------------------------------------
async function handleEventsVolume(
  request: Request,
  env: Env,
  agentId: string
): Promise<Response> {
  const url = parseUrl(request);
  const daysParam = parseInt(url.searchParams.get("days") || "30", 10);
  const days = Math.min(Math.max(daysParam, 1), 90);

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  // Get agent subscriptions to know which sources to count
  const config = await loadAgentConfig(env.DB, agentId);
  if (!config) return errorJson("Agent not found", 404);

  const sources = [...new Set(config.subscriptions.map((s) => s.source))];

  if (sources.length === 0) {
    return json([]);
  }

  // Build query for daily event counts grouped by source and date
  const placeholders = sources.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT
       source,
       DATE(timestamp) as date,
       COUNT(*) as count
     FROM events
     WHERE source IN (${placeholders})
       AND timestamp >= ?
     GROUP BY source, DATE(timestamp)
     ORDER BY date ASC`
  )
    .bind(...sources, sinceStr)
    .all<{ source: string; date: string; count: number }>();

  return json(results || []);
}

// ---------------------------------------------------------------------------
// POST /api/agents/:id/trigger/:reportType
// ---------------------------------------------------------------------------
async function handleTrigger(
  request: Request,
  env: Env,
  agentId: string,
  reportType: string
): Promise<Response> {
  const reqUrl = new URL(request.url);
  const asOf = reqUrl.searchParams.get("asOf");
  const runtimeUrl = `https://openchief-runtime/trigger/${agentId}/${reportType}${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ""}`;

  const runtimeResponse = await env.AGENT_RUNTIME.fetch(runtimeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Email": await getUserEmail(request, env),
    },
  });

  const data = await runtimeResponse.text();
  return new Response(data, {
    status: runtimeResponse.status,
    headers: {
      "Content-Type": runtimeResponse.headers.get("Content-Type") || "application/json",
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/connections
// ---------------------------------------------------------------------------
async function handleListConnections(env: Env): Promise<Response> {
  // Get event stats per source from the events table
  let eventStats: Record<string, { total: number; latest: string }> = {};
  try {
    const { results } = await env.DB.prepare(
      `SELECT
         source,
         COUNT(*) as total,
         MAX(timestamp) as latest
       FROM events
       GROUP BY source`
    ).all<{ source: string; total: number; latest: string }>();

    for (const row of results || []) {
      eventStats[row.source] = { total: row.total, latest: row.latest };
    }
  } catch {
    // events table may not exist yet
  }

  const connections = Object.entries(CONNECTOR_CONFIGS).map(([source, cfg]) => {
    const stats = eventStats[source];
    return {
      source,
      label: cfg.displayName,
      icon: source,
      eventCount: stats?.total || 0,
      lastEventAt: stats?.latest || null,
      connectionType: stats ? "connected" : "not_configured",
      description: null,
    };
  });

  return json(connections);
}

// ---------------------------------------------------------------------------
// GET /api/connections/:source/settings
// ---------------------------------------------------------------------------
async function handleGetConnectionSettings(
  env: Env,
  source: string
): Promise<Response> {
  const cfg = CONNECTOR_CONFIGS[source];
  if (!cfg) return errorJson("Unknown connector", 404);

  // Load masked metadata from KV for each field
  const fields = await Promise.all(
    cfg.fields.map(async (field) => {
      const kvKey = `connector-secret:${source}:${field.name}`;
      const metadata = await env.KV.get(kvKey, { type: "text" });

      return {
        key: field.name,
        label: field.label,
        secret: field.secret,
        required: true,
        placeholder: field.placeholder || null,
        description: null,
        configured: metadata !== null,
        maskedValue: metadata ? maskValue(metadata) : null,
        updatedAt: null,
      };
    })
  );

  return json({
    source,
    label: cfg.displayName,
    icon: source,
    workerName: cfg.workerName,
    fields,
  });
}

// ---------------------------------------------------------------------------
// PUT /api/connections/:source/settings
// ---------------------------------------------------------------------------
async function handleUpdateConnectionSettings(
  request: Request,
  env: Env,
  source: string
): Promise<Response> {
  const cfg = CONNECTOR_CONFIGS[source];
  if (!cfg) return errorJson("Unknown connector", 404);

  const body = (await request.json()) as Record<string, string>;

  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    return errorJson(
      "CF_API_TOKEN and CF_ACCOUNT_ID must be configured to manage connector secrets",
      500
    );
  }

  const validFieldNames = new Set(cfg.fields.map((f) => f.name));
  const errors: string[] = [];
  const updated: string[] = [];

  for (const [fieldName, value] of Object.entries(body)) {
    if (!validFieldNames.has(fieldName)) {
      errors.push(`Unknown field: ${fieldName}`);
      continue;
    }

    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`Empty value for ${fieldName}`);
      continue;
    }

    const fieldDef = cfg.fields.find((f) => f.name === fieldName)!;

    if (fieldDef.secret) {
      // Set as a Cloudflare Worker secret via API
      const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${cfg.workerName}/secrets`;

      const cfResponse = await fetch(apiUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: fieldName,
          text: value.trim(),
          type: "secret_text",
        }),
      });

      if (!cfResponse.ok) {
        const cfError = await cfResponse.text();
        errors.push(`Failed to set ${fieldName}: ${cfError}`);
        continue;
      }
    } else {
      // Set as a plain text environment variable via Worker settings API
      // For non-secret vars, we use the settings endpoint
      const settingsUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${cfg.workerName}/settings`;

      const cfResponse = await fetch(settingsUrl, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          settings: {
            bindings: [
              {
                type: "plain_text",
                name: fieldName,
                text: value.trim(),
              },
            ],
          },
        }),
      });

      if (!cfResponse.ok) {
        const cfError = await cfResponse.text();
        errors.push(`Failed to set ${fieldName}: ${cfError}`);
        continue;
      }
    }

    // Store masked metadata in KV so we know the field is configured
    const kvKey = `connector-secret:${source}:${fieldName}`;
    await env.KV.put(kvKey, value.trim());
    updated.push(fieldName);
  }

  if (errors.length > 0 && updated.length === 0) {
    return errorJson(errors.join("; "), 400);
  }

  return json({
    updated,
    errors: errors.length > 0 ? errors : undefined,
  });
}

// ---------------------------------------------------------------------------
// GET /api/connections/:source/events
// ---------------------------------------------------------------------------
async function handleGetConnectionEvents(
  env: Env,
  source: string
): Promise<Response> {
  if (!CONNECTOR_CONFIGS[source]) return errorJson("Unknown connector", 404);

  const { results } = await env.DB.prepare(
    `SELECT id, timestamp, source, event_type, scope_org, scope_project, scope_team, scope_actor, summary, tags
     FROM events
     WHERE source = ?
     ORDER BY timestamp DESC
     LIMIT 100`
  )
    .bind(source)
    .all<{
      id: string;
      timestamp: string;
      source: string;
      event_type: string;
      scope_org: string | null;
      scope_project: string | null;
      scope_team: string | null;
      scope_actor: string | null;
      summary: string;
      tags: string | null;
    }>();

  const events = (results || []).map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    source: row.source,
    eventType: row.event_type,
    actor: row.scope_actor,
    project: row.scope_project,
    summary: row.summary,
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));

  return json(events);
}

// ---------------------------------------------------------------------------
// GET /api/connections/:source/stats
// ---------------------------------------------------------------------------
async function handleGetConnectionStats(
  env: Env,
  source: string
): Promise<Response> {
  if (!CONNECTOR_CONFIGS[source]) return errorJson("Unknown connector", 404);

  // Run all three queries in parallel
  const [volumeResult, typesResult, actorsResult] = await Promise.all([
    // Daily event volume for last 30 days
    env.DB.prepare(
      `SELECT DATE(timestamp) as date, COUNT(*) as count
       FROM events
       WHERE source = ? AND timestamp >= datetime('now', '-30 days')
       GROUP BY DATE(timestamp)
       ORDER BY date ASC`
    )
      .bind(source)
      .all<{ date: string; count: number }>(),

    // Event type breakdown (top 10)
    env.DB.prepare(
      `SELECT event_type, COUNT(*) as count
       FROM events
       WHERE source = ? AND timestamp >= datetime('now', '-30 days')
       GROUP BY event_type
       ORDER BY count DESC
       LIMIT 10`
    )
      .bind(source)
      .all<{ event_type: string; count: number }>(),

    // Top actors (top 8)
    env.DB.prepare(
      `SELECT scope_actor as actor, COUNT(*) as count
       FROM events
       WHERE source = ? AND scope_actor IS NOT NULL AND timestamp >= datetime('now', '-30 days')
       GROUP BY scope_actor
       ORDER BY count DESC
       LIMIT 8`
    )
      .bind(source)
      .all<{ actor: string; count: number }>(),
  ]);

  return json({
    volume: volumeResult.results || [],
    eventTypes: (typesResult.results || []).map((r) => ({
      eventType: r.event_type,
      count: r.count,
    })),
    topActors: actorsResult.results || [],
  });
}

// ---------------------------------------------------------------------------
// GET /api/connections/:source/access
// ---------------------------------------------------------------------------
async function handleGetConnectionAccess(
  env: Env,
  source: string
): Promise<Response> {
  if (!CONNECTOR_CONFIGS[source]) return errorJson("Unknown connector", 404);

  // Data-driven: find agents whose tools array contains a tool that maps to this source
  const toolName = SOURCE_TO_TOOL[source];

  const { results } = await env.DB.prepare(
    "SELECT id, config FROM agent_definitions WHERE json_extract(config, '$.enabled') = true ORDER BY id"
  ).all<{ id: string; config: string }>();

  const agentsWithAccess: Array<{ id: string; name: string; tools: string[] }> = [];

  for (const row of results || []) {
    const config = JSON.parse(row.config) as AgentDefinition;
    const agentTools = config.tools || [];

    // An agent has access to this connection if:
    // 1. Its tools array contains the mapped tool name for this source
    // 2. OR it subscribes to events from this source (passive access)
    const hasToolAccess = toolName ? agentTools.includes(toolName) : false;
    const hasSubscriptionAccess = config.subscriptions.some((sub) => sub.source === source);

    if (hasToolAccess || hasSubscriptionAccess) {
      agentsWithAccess.push({
        id: config.id,
        name: config.name,
        tools: agentTools,
      });
    }
  }

  return json({
    source,
    toolName: toolName || null,
    agents: agentsWithAccess,
  });
}

// ---------------------------------------------------------------------------
// POST /api/connections/:source/sync  — proxy to connector /poll
// ---------------------------------------------------------------------------

/** Map connector source name → env binding name (e.g. "slack" → "CONNECTOR_SLACK") */
function connectorBindingName(source: string): `CONNECTOR_${string}` {
  return `CONNECTOR_${source.toUpperCase().replace(/-/g, "_")}` as `CONNECTOR_${string}`;
}

async function handleConnectionSync(
  _request: Request,
  env: Env,
  source: string,
): Promise<Response> {
  const cfg = CONNECTOR_CONFIGS[source];
  if (!cfg) return errorJson("Unknown connector", 404);

  // Read admin secret from KV (already stored when user saves connector settings)
  const adminSecret = await env.KV.get(`connector-secret:${source}:ADMIN_SECRET`);
  const needsSecret = cfg.fields.some((f) => f.name === "ADMIN_SECRET");
  if (needsSecret && !adminSecret) {
    return errorJson(
      "ADMIN_SECRET not configured for this connector. Set it in the connector settings first.",
      400,
    );
  }

  // Look up the service binding for this connector
  const bindingKey = connectorBindingName(source);
  const binding = env[bindingKey];
  if (!binding) {
    return errorJson(
      `Service binding "${bindingKey}" not configured. Add it to the dashboard worker's wrangler.jsonc: { "binding": "${bindingKey}", "service": "${cfg.workerName}" }`,
      500,
    );
  }

  try {
    const headers: Record<string, string> = {};
    if (adminSecret) headers["Authorization"] = `Bearer ${adminSecret}`;

    // Use service binding to call the connector — avoids workers.dev routing limitations
    // Pass ?task=identity to only sync people/identities, not backfill events
    const resp = await binding.fetch("https://connector/poll?task=identity", { method: "POST", headers });
    const body = await resp.text();

    if (!resp.ok) {
      return json({ ok: false, error: `Connector returned ${resp.status}`, detail: body }, resp.status);
    }

    let result: unknown;
    try {
      result = JSON.parse(body);
    } catch {
      result = { raw: body };
    }
    return json({ ok: true, ...((result && typeof result === "object") ? result : { result }) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to reach connector";
    return json({ ok: false, error: msg }, 502);
  }
}

// ---------------------------------------------------------------------------
// GET/PUT /api/connections/:source/projects — proxy to connector /projects
// ---------------------------------------------------------------------------

async function handleGetConnectionProjects(
  env: Env,
  source: string,
): Promise<Response> {
  const cfg = CONNECTOR_CONFIGS[source];
  if (!cfg) return errorJson("Unknown connector", 404);

  const adminSecret = await env.KV.get(`connector-secret:${source}:ADMIN_SECRET`);
  if (!adminSecret) {
    return errorJson(
      "ADMIN_SECRET not configured. Set it in the connector settings first.",
      400,
    );
  }

  const bindingKey = connectorBindingName(source);
  const binding = env[bindingKey];
  if (!binding) {
    return errorJson(`Service binding "${bindingKey}" not configured`, 500);
  }

  try {
    const resp = await binding.fetch("https://connector/projects", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminSecret}` },
    });
    const body = await resp.text();
    if (!resp.ok) {
      return json(
        { ok: false, error: `Connector returned ${resp.status}`, detail: body },
        resp.status,
      );
    }
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to reach connector";
    return json({ ok: false, error: msg }, 502);
  }
}

async function handleUpdateConnectionProjects(
  request: Request,
  env: Env,
  source: string,
): Promise<Response> {
  const cfg = CONNECTOR_CONFIGS[source];
  if (!cfg) return errorJson("Unknown connector", 404);

  const adminSecret = await env.KV.get(`connector-secret:${source}:ADMIN_SECRET`);
  if (!adminSecret) {
    return errorJson(
      "ADMIN_SECRET not configured. Set it in the connector settings first.",
      400,
    );
  }

  const bindingKey = connectorBindingName(source);
  const binding = env[bindingKey];
  if (!binding) {
    return errorJson(`Service binding "${bindingKey}" not configured`, 500);
  }

  try {
    const body = await request.text();
    const resp = await binding.fetch("https://connector/projects", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminSecret}`,
        "Content-Type": "application/json",
      },
      body,
    });
    const respBody = await resp.text();
    if (!resp.ok) {
      return json(
        { ok: false, error: `Connector returned ${resp.status}`, detail: respBody },
        resp.status,
      );
    }
    return new Response(respBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to reach connector";
    return json({ ok: false, error: msg }, 502);
  }
}

// ---------------------------------------------------------------------------
// GET /api/identities
// ---------------------------------------------------------------------------
async function handleListIdentities(env: Env): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, email, real_name AS realName, display_name AS displayName,
              avatar_url AS avatarUrl, team, role,
              github_username AS githubUsername, slack_user_id AS slackUserId,
              discord_handle AS discordHandle, figma_handle AS figmaHandle,
              is_bot AS isBot, is_active AS isActive,
              created_at AS createdAt, updated_at AS updatedAt
       FROM identity_mappings
       ORDER BY COALESCE(display_name, real_name) ASC`
    ).all();

    // Convert integer booleans to JS booleans and resolve superadmin by email
    const saEmail = env.SUPERADMIN_EMAIL?.toLowerCase();
    const mapped = (results || []).map((r: Record<string, unknown>) => ({
      ...r,
      isBot: r.isBot === 1,
      isActive: r.isActive === 1,
      role:
        saEmail && typeof r.email === "string" && r.email.toLowerCase() === saEmail
          ? "superadmin"
          : r.role ?? null,
    }));

    return json(mapped);
  } catch {
    // Table may not exist yet
    return json([]);
  }
}

// ---------------------------------------------------------------------------
// POST /api/identities/merge
// ---------------------------------------------------------------------------
async function handleMergeIdentities(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as { primaryId: string; secondaryId: string };

  if (!body.primaryId || !body.secondaryId) {
    return errorJson("primaryId and secondaryId are required");
  }
  if (body.primaryId === body.secondaryId) {
    return errorJson("Cannot merge an identity with itself");
  }

  // Load both rows
  const primary = await env.DB.prepare(
    "SELECT * FROM identity_mappings WHERE id = ?"
  )
    .bind(body.primaryId)
    .first<Record<string, string | null>>();

  const secondary = await env.DB.prepare(
    "SELECT * FROM identity_mappings WHERE id = ?"
  )
    .bind(body.secondaryId)
    .first<Record<string, string | null>>();

  if (!primary) return errorJson("Primary identity not found", 404);
  if (!secondary) return errorJson("Secondary identity not found", 404);

  // Merge: fill in null fields on primary from secondary
  const mergeFields = [
    "email",
    "display_name",
    "avatar_url",
    "team",
    "role",
    "github_username",
    "slack_user_id",
    "discord_handle",
    "figma_handle",
  ];

  const updates: string[] = [];
  const values: (string | null)[] = [];

  for (const field of mergeFields) {
    if (!primary[field] && secondary[field]) {
      updates.push(`${field} = ?`);
      values.push(secondary[field]);
    }
  }

  const now = new Date().toISOString();

  // Delete the secondary FIRST, then update primary in a separate statement.
  // We can't use env.DB.batch() because D1/SQLite checks UNIQUE constraints
  // per-statement within a transaction — the UPDATE would fail even though
  // the DELETE ran first in the same batch.
  await env.DB.prepare("DELETE FROM identity_mappings WHERE id = ?")
    .bind(body.secondaryId)
    .run();

  if (updates.length > 0) {
    updates.push("updated_at = ?");
    values.push(now);
    values.push(body.primaryId);

    await env.DB.prepare(
      `UPDATE identity_mappings SET ${updates.join(", ")} WHERE id = ?`
    ).bind(...values).run();
  }

  // Return the merged primary
  const merged = await env.DB.prepare(
    "SELECT * FROM identity_mappings WHERE id = ?"
  )
    .bind(body.primaryId)
    .first();

  return json(merged);
}

// ---------------------------------------------------------------------------
// PUT /api/identities/:id/role (superadmin only)
// ---------------------------------------------------------------------------
async function handleUpdateIdentityRole(
  request: Request,
  env: Env,
  identityId: string,
): Promise<Response> {
  // Only superadmin can update roles
  const callerEmail = await getUserEmail(request, env);
  const callerRole = await getUserRole(callerEmail, env);
  if (callerRole !== "superadmin") {
    return errorJson("Superadmin access required", 403);
  }

  const body = (await request.json()) as { role: "exec" | null };
  const newRole = body.role;

  // Validate role value
  if (newRole !== null && newRole !== "exec") {
    return errorJson("Invalid role. Must be \"exec\" or null.", 400);
  }

  // Check identity exists
  const identity = await env.DB.prepare(
    "SELECT id FROM identity_mappings WHERE id = ?",
  )
    .bind(identityId)
    .first();
  if (!identity) {
    return errorJson("Identity not found", 404);
  }

  // Update role
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE identity_mappings SET role = ?, updated_at = ? WHERE id = ?",
  )
    .bind(newRole, now, identityId)
    .run();

  return json({ ok: true, role: newRole });
}

// ---------------------------------------------------------------------------
// PUT /api/identities/:id/active (superadmin only)
// ---------------------------------------------------------------------------
async function handleUpdateIdentityActive(
  request: Request,
  env: Env,
  identityId: string,
): Promise<Response> {
  const callerEmail = await getUserEmail(request, env);
  const callerRole = await getUserRole(callerEmail, env);
  if (callerRole !== "superadmin") {
    return errorJson("Superadmin access required", 403);
  }

  const body = (await request.json()) as { isActive: boolean };
  const isActive = body.isActive ? 1 : 0;

  const identity = await env.DB.prepare(
    "SELECT id FROM identity_mappings WHERE id = ?",
  )
    .bind(identityId)
    .first();
  if (!identity) {
    return errorJson("Identity not found", 404);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE identity_mappings SET is_active = ?, updated_at = ? WHERE id = ?",
  )
    .bind(isActive, now, identityId)
    .run();

  return json({ ok: true, isActive: isActive === 1 });
}

// ---------------------------------------------------------------------------
// GET /api/jobs/status
// ---------------------------------------------------------------------------
async function handleJobsStatus(request: Request, env: Env): Promise<Response> {
  const url = parseUrl(request);
  const dateParam = url.searchParams.get("date");

  // Default to today
  const date = dateParam || new Date().toISOString().split("T")[0];

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return errorJson("Invalid date format. Use YYYY-MM-DD.");
  }

  const dateStart = `${date}T00:00:00.000Z`;
  const dateEnd = `${date}T23:59:59.999Z`;

  // Get all agents
  const { results: agentRows } = await env.DB.prepare(
    "SELECT id, config FROM agent_definitions WHERE json_extract(config, '$.enabled') = true ORDER BY id"
  ).all<{ id: string; config: string }>();

  // Get reports generated on this date (include id, content for headline/health, event_count)
  const { results: reportRows } = await env.DB.prepare(
    `SELECT id, agent_id, report_type, content, event_count, created_at
     FROM reports
     WHERE created_at >= ? AND created_at <= ?
     ORDER BY created_at DESC`
  )
    .bind(dateStart, dateEnd)
    .all<{ id: string; agent_id: string; report_type: string; content: string; event_count: number | null; created_at: string }>();

  // Build a lookup: agentId:reportType -> report details
  const reportLookup = new Map<string, {
    id: string; reportType: string; createdAt: string;
    healthSignal: string | null; headline: string | null; eventCount: number | null;
  }>();
  for (const row of reportRows || []) {
    const key = `${row.agent_id}:${row.report_type}`;
    if (!reportLookup.has(key)) {
      let headline: string | null = null;
      let healthSignal: string | null = null;
      try {
        const parsed = JSON.parse(row.content);
        headline = parsed.headline || null;
        healthSignal = parsed.healthSignal || null;
      } catch { /* ignore */ }
      reportLookup.set(key, {
        id: row.id,
        reportType: row.report_type,
        createdAt: row.created_at,
        healthSignal,
        headline,
        eventCount: row.event_count,
      });
    }
  }

  // Compute next scheduled run time for pending jobs
  const reportHour = parseInt(env.REPORT_TIME_UTC_HOUR || "14", 10);
  const now = new Date();

  function computeNextRunAt(cadence: string): string | null {
    // Daily reports run Mon-Fri at reportHour:00 UTC
    // Weekly reports run on Monday at reportHour:00 UTC
    const target = new Date(now);
    target.setUTCHours(reportHour, 0, 0, 0);

    if (cadence === "daily") {
      // If today's run time hasn't passed yet and it's a weekday, use today
      const dow = target.getUTCDay(); // 0=Sun, 6=Sat
      if (target > now && dow >= 1 && dow <= 5) {
        return target.toISOString();
      }
      // Otherwise find next weekday
      target.setUTCDate(target.getUTCDate() + 1);
      while (target.getUTCDay() === 0 || target.getUTCDay() === 6) {
        target.setUTCDate(target.getUTCDate() + 1);
      }
      return target.toISOString();
    }

    if (cadence === "weekly") {
      // Next Monday at reportHour:00 UTC
      const dow = target.getUTCDay();
      if (dow === 1 && target > now) {
        return target.toISOString(); // It's Monday and hasn't run yet
      }
      // Find next Monday
      const daysUntilMonday = dow === 0 ? 1 : (8 - dow);
      target.setUTCDate(target.getUTCDate() + daysUntilMonday);
      return target.toISOString();
    }

    return null;
  }

  const jobs = (agentRows || []).map((row) => {
    const config = JSON.parse(row.config) as AgentDefinition;
    const expectedReports = config.outputs.reports.map((r) => {
      const key = `${config.id}:${r.reportType}`;
      const generated = reportLookup.get(key);
      return {
        reportType: r.reportType,
        cadence: r.cadence,
        completed: !!generated,
        reportId: generated?.id || null,
        healthSignal: generated?.healthSignal || null,
        headline: generated?.headline || null,
        completedAt: generated?.createdAt || null,
        eventCount: generated?.eventCount || null,
        nextRunAt: generated ? null : computeNextRunAt(r.cadence),
      };
    });

    return {
      agentId: config.id,
      agentName: config.name,
      expectedReports,
    };
  });

  return json(jobs);
}

// ---------------------------------------------------------------------------
// GET /api/models
// ---------------------------------------------------------------------------
async function handleListModels(env: Env): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT job_type, model, updated_at FROM model_settings ORDER BY job_type"
    ).all<{ job_type: string; model: string; updated_at: string }>();

    // Fill in defaults for job types not yet in the table
    const defaults: Record<string, string> = {
      "daily-report": "claude-sonnet-4-6",
      "weekly-report": "claude-sonnet-4-6",
      chat: "claude-sonnet-4-6",
    };

    const existing = new Map((results || []).map((r) => [r.job_type, r]));

    const models = Object.entries(defaults).map(([jobType, defaultModel]) => {
      const row = existing.get(jobType);
      return {
        jobType,
        model: row?.model || defaultModel,
        updatedAt: row?.updated_at || null,
      };
    });

    return json(models);
  } catch {
    // Table may not exist yet — return defaults
    return json([
      { jobType: "daily-report", model: "claude-sonnet-4-6", updatedAt: null },
      { jobType: "weekly-report", model: "claude-sonnet-4-6", updatedAt: null },
      { jobType: "chat", model: "claude-sonnet-4-6", updatedAt: null },
    ]);
  }
}

// ---------------------------------------------------------------------------
// PUT /api/models/:jobType
// ---------------------------------------------------------------------------
async function handleUpdateModel(
  request: Request,
  env: Env,
  jobType: string
): Promise<Response> {
  const validJobTypes = new Set(["daily-report", "weekly-report", "chat"]);
  if (!validJobTypes.has(jobType)) {
    return errorJson(
      `Invalid job type. Must be one of: ${[...validJobTypes].join(", ")}`
    );
  }

  const body = (await request.json()) as { model: string };
  const validModels = new Set([
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5",
  ]);
  if (!body.model || !validModels.has(body.model)) {
    return errorJson(
      `Invalid model. Must be one of: ${[...validModels].join(", ")}`
    );
  }

  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO model_settings (job_type, model, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(job_type) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`
  )
    .bind(jobType, body.model, now)
    .run();

  return json({ jobType, model: body.model, updatedAt: now });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function rowToTask(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    createdBy: row.created_by,
    assignedTo: row.assigned_to,
    sourceReportId: row.source_report_id,
    output: row.output ? JSON.parse(row.output as string) : null,
    context: row.context ? JSON.parse(row.context as string) : null,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    dueBy: row.due_by,
    tokensUsed: row.tokens_used,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handleListTasks(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const assignedTo = url.searchParams.get("assignedTo");
  const createdBy = url.searchParams.get("createdBy");
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || "50", 10),
    100,
  );

  let sql = "SELECT * FROM tasks WHERE 1=1";
  const params: unknown[] = [];

  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (assignedTo) {
    sql += " AND assigned_to = ?";
    params.push(assignedTo);
  }
  if (createdBy) {
    sql += " AND created_by = ?";
    params.push(createdBy);
  }

  sql += " ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'queued' THEN 1 WHEN 'proposed' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END, priority DESC, created_at DESC LIMIT ?";
  params.push(limit);

  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all();

  return json((results ?? []).map((r) => rowToTask(r as Record<string, unknown>)));
}

async function handleGetTask(
  env: Env,
  taskId: string,
): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?")
    .bind(taskId)
    .first();

  if (!row) return errorJson("Task not found", 404);
  return json(rowToTask(row as Record<string, unknown>));
}

async function handleCreateTask(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = (await request.json()) as {
    title?: string;
    description?: string;
    assignedTo?: string;
    priority?: number;
    dueBy?: string;
  };

  if (!body.title || !body.description) {
    return errorJson("title and description are required");
  }

  const email = await getUserEmail(request, env);
  const taskId = generateULID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO tasks (id, title, description, status, priority, created_by, assigned_to, due_by, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      taskId,
      body.title,
      body.description,
      body.priority ?? 50,
      `user:${email}`,
      body.assignedTo || null,
      body.dueBy || null,
      now,
      now,
    )
    .run();

  return json({ id: taskId }, 201);
}

async function handleUpdateTask(
  request: Request,
  env: Env,
  taskId: string,
): Promise<Response> {
  const existing = await env.DB.prepare("SELECT id FROM tasks WHERE id = ?")
    .bind(taskId)
    .first();
  if (!existing) return errorJson("Task not found", 404);

  const body = (await request.json()) as {
    status?: string;
    priority?: number;
    assignedTo?: string;
    dueBy?: string;
  };

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.status !== undefined) {
    updates.push("status = ?");
    params.push(body.status);
    if (body.status === "completed") {
      updates.push("completed_at = ?");
      params.push(new Date().toISOString());
    }
    if (body.status === "in_progress") {
      updates.push("started_at = ?");
      params.push(new Date().toISOString());
    }
  }
  if (body.priority !== undefined) {
    updates.push("priority = ?");
    params.push(body.priority);
  }
  if (body.assignedTo !== undefined) {
    updates.push("assigned_to = ?");
    params.push(body.assignedTo || null);
  }
  if (body.dueBy !== undefined) {
    updates.push("due_by = ?");
    params.push(body.dueBy || null);
  }

  if (updates.length === 0) {
    return errorJson("No fields to update");
  }

  updates.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(taskId);

  await env.DB.prepare(
    `UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...params)
    .run();

  return json({ ok: true });
}

async function handleTaskStats(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT status, COUNT(*) as count FROM tasks GROUP BY status",
  ).all<{ status: string; count: number }>();

  return json(results ?? []);
}

// ---------------------------------------------------------------------------
// POST /api/tools/generate-voice
// ---------------------------------------------------------------------------
async function handleGenerateVoice(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = (await request.json()) as { identityId: string };

  if (!body.identityId) {
    return errorJson("identityId is required");
  }

  // Load identity to get display name and real name
  const identity = await env.DB.prepare(
    "SELECT id, display_name, real_name, slack_user_id FROM identity_mappings WHERE id = ?",
  )
    .bind(body.identityId)
    .first<{
      id: string;
      display_name: string | null;
      real_name: string | null;
      slack_user_id: string | null;
    }>();

  if (!identity) {
    return errorJson("Identity not found", 404);
  }

  const personName = identity.display_name || identity.real_name || "Unknown";

  // Build name matching — scope_actor can be either display_name or real_name
  const possibleNames = [identity.display_name, identity.real_name].filter(
    (n): n is string => !!n,
  );

  if (possibleNames.length === 0) {
    return errorJson(
      "No name found for this identity — cannot match Slack messages",
    );
  }

  // Query Slack messages from the last 30 days by scope_actor
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const placeholders = possibleNames.map(() => "scope_actor = ?").join(" OR ");
  const { results: messageRows } = await env.DB.prepare(
    `SELECT payload, timestamp FROM events
     WHERE source = 'slack'
       AND event_type LIKE 'message.%'
       AND (${placeholders})
       AND timestamp >= ?
     ORDER BY timestamp DESC
     LIMIT 500`,
  )
    .bind(...possibleNames, thirtyDaysAgo)
    .all<{ payload: string; timestamp: string }>();

  if (!messageRows || messageRows.length === 0) {
    return errorJson(
      `No Slack messages found for "${personName}" in the last 30 days. Make sure the Slack connector is active and has ingested recent messages. Try clicking "Refresh Slack Data" first.`,
      404,
    );
  }

  // Extract text from each message payload
  const messages: string[] = [];
  let oldestTs: string | null = null;
  let newestTs: string | null = null;
  for (const row of messageRows) {
    try {
      const payload = JSON.parse(row.payload) as { text?: string };
      if (payload.text && typeof payload.text === "string" && payload.text.trim()) {
        messages.push(payload.text.trim());
        if (!newestTs) newestTs = row.timestamp;
        oldestTs = row.timestamp;
      }
    } catch {
      // Skip malformed payloads
    }
  }

  if (messages.length < 10) {
    return errorJson(
      `Only ${messages.length} Slack messages with text found for "${personName}" in the last 30 days. Need at least 10 for meaningful analysis. Try clicking "Refresh Slack Data" to pull the latest messages.`,
    );
  }

  // Proxy to runtime worker for Claude analysis
  const runtimeResponse = await env.AGENT_RUNTIME.fetch(
    "https://openchief-runtime/tools/generate-voice",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personName, messages }),
    },
  );

  // Enrich runtime response with date range info
  const runtimeData = await runtimeResponse.text();
  if (runtimeResponse.status === 200) {
    try {
      const parsed = JSON.parse(runtimeData);
      return json({
        ...parsed,
        dateRange: { oldest: oldestTs, newest: newestTs },
      });
    } catch {
      // fall through
    }
  }

  return new Response(runtimeData, {
    status: runtimeResponse.status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /api/tools/slack-message-counts
// ---------------------------------------------------------------------------
async function handleSlackMessageCounts(env: Env): Promise<Response> {
  // Count Slack messages per scope_actor from last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT scope_actor AS name, COUNT(*) AS count
     FROM events
     WHERE source = 'slack'
       AND event_type LIKE 'message.%'
       AND scope_actor IS NOT NULL
       AND scope_actor != ''
       AND timestamp >= ?
     GROUP BY scope_actor
     ORDER BY count DESC`,
  )
    .bind(thirtyDaysAgo)
    .all<{ name: string; count: number }>();

  // Also get total Slack event count (any type) for the "has data" check
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM events WHERE source = 'slack'`,
  ).first<{ count: number }>();

  return json({
    totalSlackEvents: total?.count ?? 0,
    messageCounts: results ?? [],
  });
}

// ---------------------------------------------------------------------------
// POST /api/tools/refresh-slack
// ---------------------------------------------------------------------------
async function handleRefreshSlack(env: Env): Promise<Response> {
  // Trigger a fresh Slack poll to ingest the latest messages into D1
  const binding = env["CONNECTOR_SLACK" as keyof Env] as Fetcher | undefined;
  if (!binding) {
    return errorJson(
      "Slack connector is not configured. Add it from the Connections page first.",
      400,
    );
  }

  const adminSecret = await env.KV.get("connector-secret:slack:ADMIN_SECRET");
  const headers: Record<string, string> = {};
  if (adminSecret) headers["Authorization"] = `Bearer ${adminSecret}`;

  try {
    const resp = await binding.fetch("https://connector/poll", {
      method: "POST",
      headers,
    });
    const body = await resp.text();

    if (!resp.ok) {
      return json(
        { ok: false, error: `Slack connector returned ${resp.status}`, detail: body },
        resp.status,
      );
    }

    let result: unknown;
    try {
      result = JSON.parse(body);
    } catch {
      result = { raw: body };
    }
    return json({ ok: true, ...((result && typeof result === "object") ? result : { result }) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return json({ ok: false, error: `Failed to reach Slack connector: ${msg}` }, 500);
  }
}
