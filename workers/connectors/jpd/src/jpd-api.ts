/**
 * Jira Product Discovery (JPD) API client.
 *
 * JPD ideas are stored as Jira issues of type "Idea" within a JPD project.
 * We use the standard Jira REST API v3 to poll for idea changes, plus the
 * JPD-specific API for insights and delivery tracking.
 *
 * Docs: https://developer.atlassian.com/cloud/jira/product-discovery/rest/
 */

// ─── JPD Custom Field IDs ────────────────────────────────────────────────────
// These are the custom fields used by Jira Product Discovery for prioritization.
// Note: some fields have two IDs because JPD creates project-scoped copies.
// We check both and use whichever is populated.
export const JPD_FIELDS = {
  // Rank — lexo-rank string that determines board ordering (drag-and-drop priority)
  RANK: "customfield_10019",
  // Impact — 1-5 star rating
  IMPACT: ["customfield_10032", "customfield_10085"],
  // Impact Score — formula-calculated composite score
  IMPACT_SCORE: ["customfield_10044", "customfield_10097"],
  // Value — 1-5 star rating
  VALUE: ["customfield_10051", "customfield_10104"],
  // Effort — 1-5 star rating
  EFFORT: ["customfield_10052", "customfield_10105"],
  // Confidence — 0-100 slider
  CONFIDENCE: ["customfield_10054", "customfield_10107"],
  // Goal — Now / Next / Later checkboxes
  GOAL: ["customfield_10038", "customfield_10091"],
  // Roadmap — select field
  ROADMAP: ["customfield_10039", "customfield_10092"],
  // Strategy — multi-select checkboxes
  STRATEGY: "customfield_10110",
  // Feature Lead — people field
  FEATURE_LEAD: "customfield_10079",
  // Complete? — boolean checkbox
  COMPLETE: "customfield_10073",
  // Design Status — select dropdown
  DESIGN_STATUS: "customfield_10072",
  // Designs ready — boolean
  DESIGNS_READY: "customfield_10100",
  // Spec ready — boolean
  SPEC_READY: ["customfield_10099", "customfield_10046"],
  // Delivery progress & status — JPD computed fields
  DELIVERY_PROGRESS: "customfield_10121",
  DELIVERY_STATUS: "customfield_10122",
  // Insights count
  INSIGHTS_COUNT: "customfield_10118",
} as const;

/** All JPD custom field IDs flattened into a single array for API requests. */
export const ALL_JPD_FIELD_IDS: string[] = Object.values(JPD_FIELDS).flat();

export interface JpdIdea {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: unknown;
    status: { name: string; statusCategory: { key: string; name: string } };
    issuetype: { name: string };
    priority?: { name: string };
    assignee?: { accountId: string; displayName: string } | null;
    reporter?: { accountId: string; displayName: string };
    creator?: { accountId: string; displayName: string };
    project: { id: string; key: string; name: string };
    labels: string[];
    created: string;
    updated: string;
    comment?: { total: number; comments: JpdComment[] };
    changelog?: { histories: JpdChangelogEntry[] };
    // JPD custom fields (vary by project, common ones below)
    [key: string]: unknown;
  };
}

export interface JpdComment {
  id: string;
  author: { accountId: string; displayName: string };
  body: unknown;
  created: string;
  updated: string;
}

export interface JpdChangelogEntry {
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

export interface JpdInsight {
  id: string;
  description: string;
  created: string;
  updated: string;
  author?: { accountId: string; displayName: string };
  category?: string;
  source?: string;
}

interface SearchResult {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JpdIdea[];
}

/**
 * Create a JPD API client.
 */
export function createJpdClient(instanceUrl: string, email: string, apiToken: string) {
  const baseUrl = instanceUrl.replace(/\/$/, "");
  const authHeader = `Basic ${btoa(`${email}:${apiToken}`)}`;

  async function jpdFetch<T>(
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
    const res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "openchief-connector-jpd",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`JPD API ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json() as Promise<T>;
  }

  return {
    /**
     * Search for JPD ideas (Jira issues with type "Idea" or in JPD projects).
     * Uses standard Jira search with JQL, expanding changelog.
     */
    async searchIdeas(
      jql: string,
      opts: { startAt?: number; maxResults?: number } = {}
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
            "created",
            "updated",
            "comment",
            // JPD priority & scoring custom fields
            ...ALL_JPD_FIELD_IDS,
          ];
      const params = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(maxResults),
        fields: fields.join(","),
        expand: "changelog",
      });
      return jpdFetch<SearchResult>(`/rest/api/3/search/jql?${params}`);
    },

    /**
     * Get comments on an idea (standard Jira comments endpoint).
     */
    async getComments(
      issueKey: string,
      opts: { startAt?: number; maxResults?: number } = {}
    ): Promise<{ total: number; comments: JpdComment[] }> {
      const { startAt = 0, maxResults = 50 } = opts;
      return jpdFetch<{ total: number; comments: JpdComment[] }>(
        `/rest/api/3/issue/${issueKey}/comment?startAt=${startAt}&maxResults=${maxResults}`
      );
    },
  };
}

export type JpdClient = ReturnType<typeof createJpdClient>;
