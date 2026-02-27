/**
 * Jira Service Management (JSM) API client.
 *
 * JSM requests are Jira issues with extra metadata — SLA tracking, CSAT feedback,
 * and service desk queues. Uses Jira REST API v3 for issue data plus the JSM-specific
 * `/rest/servicedeskapi/` endpoints for SLA and CSAT data.
 *
 * Auth: Basic auth (email + API token), same as Jira Cloud.
 *
 * Docs:
 *   - Jira REST v3: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 *   - JSM REST: https://developer.atlassian.com/cloud/jira/service-desk/rest/
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JsmRequest {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: unknown;
    status: { name: string; statusCategory: { key: string; name: string } };
    issuetype: { name: string; subtask: boolean };
    priority?: { name: string };
    assignee?: { accountId: string; displayName: string; emailAddress?: string } | null;
    reporter?: { accountId: string; displayName: string; emailAddress?: string };
    creator?: { accountId: string; displayName: string; emailAddress?: string };
    project: { id: string; key: string; name: string };
    labels: string[];
    components: Array<{ name: string }>;
    resolution?: { name: string } | null;
    created: string;
    updated: string;
    resolutiondate?: string | null;
    duedate?: string | null;
    comment?: { total: number; comments: JsmComment[] };
    changelog?: { histories: JsmChangelogEntry[] };
    [key: string]: unknown;
  };
}

export interface JsmComment {
  id: string;
  author: { accountId: string; displayName: string };
  body: unknown; // ADF
  created: string;
  updated: string;
}

export interface JsmChangelogEntry {
  id: string;
  author: { accountId: string; displayName: string };
  created: string;
  items: Array<{
    field: string;
    fieldtype: string;
    from: string | null;
    fromString: string | null;
    to: string | null;
    toString: string | null;
  }>;
}

export interface JsmSlaRecord {
  id: string;
  name: string;
  completedCycles: Array<{
    breached: boolean;
    goalDuration: { millis: number; friendly: string };
    elapsedTime: { millis: number; friendly: string };
    remainingTime: { millis: number; friendly: string };
  }>;
  ongoingCycle?: {
    breached: boolean;
    paused: boolean;
    goalDuration: { millis: number; friendly: string };
    elapsedTime: { millis: number; friendly: string };
    remainingTime: { millis: number; friendly: string };
  };
}

export interface JsmCsatFeedback {
  rating: number; // 1-5
  comment?: string;
  type?: string;
}

export interface JsmServiceDesk {
  id: string;
  projectId: string;
  projectName: string;
  projectKey: string;
}

interface SearchResult {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JsmRequest[];
}

// ─── Client ──────────────────────────────────────────────────────────────────

export function createJsmClient(instanceUrl: string, email: string, apiToken: string) {
  const baseUrl = instanceUrl.replace(/\/$/, "");
  const authHeader = `Basic ${btoa(`${email}:${apiToken}`)}`;

  async function jsmFetch<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
    const res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "openchief-connector-jsm",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`JSM API ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json() as Promise<T>;
  }

  return {
    /**
     * Search for JSM requests (service desk issues) using JQL.
     * Expands changelog for detecting transitions.
     */
    async searchRequests(
      jql: string,
      opts: { startAt?: number; maxResults?: number } = {},
    ): Promise<SearchResult> {
      const { startAt = 0, maxResults = 50 } = opts;
      const fields = [
        "summary",
        "description",
        "status",
        "issuetype",
        "priority",
        "assignee",
        "reporter",
        "creator",
        "project",
        "labels",
        "components",
        "resolution",
        "created",
        "updated",
        "resolutiondate",
        "duedate",
        "comment",
      ];
      const params = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(maxResults),
        fields: fields.join(","),
        expand: "changelog",
      });
      return jsmFetch<SearchResult>(`/rest/api/3/search/jql?${params}`);
    },

    /**
     * Get SLA data for a specific request.
     * Returns an array of SLA records (e.g., "Time to first response", "Time to resolution").
     */
    async getRequestSLAs(issueIdOrKey: string): Promise<JsmSlaRecord[]> {
      try {
        const result = await jsmFetch<{ values: JsmSlaRecord[] }>(
          `/rest/servicedeskapi/request/${issueIdOrKey}/sla`,
        );
        return result.values || [];
      } catch {
        // SLA endpoint may not be available for non-JSM projects
        return [];
      }
    },

    /**
     * Get CSAT feedback for a resolved request.
     * Returns null if no feedback has been provided.
     */
    async getCSATFeedback(issueIdOrKey: string): Promise<JsmCsatFeedback | null> {
      try {
        const result = await jsmFetch<JsmCsatFeedback>(
          `/rest/servicedeskapi/request/${issueIdOrKey}/feedback`,
        );
        return result.rating ? result : null;
      } catch {
        // CSAT endpoint may return 404 if no feedback exists
        return null;
      }
    },

    /**
     * List all service desks accessible to the user.
     */
    async getServiceDesks(): Promise<JsmServiceDesk[]> {
      const result = await jsmFetch<{ values: JsmServiceDesk[] }>(
        `/rest/servicedeskapi/servicedesk`,
      );
      return result.values || [];
    },
  };
}

export type JsmClient = ReturnType<typeof createJsmClient>;
