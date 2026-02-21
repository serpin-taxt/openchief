/**
 * Jira Cloud REST API client.
 *
 * Uses API token authentication (Basic auth with email + token).
 * Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 */

export interface JiraIssue {
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
    fixVersions: Array<{ name: string }>;
    resolution?: { name: string } | null;
    created: string;
    updated: string;
    resolutiondate?: string | null;
    duedate?: string | null;
    parent?: { key: string; fields?: { summary: string; issuetype?: { name: string } } };
    subtasks?: Array<{ key: string; fields: { summary: string; status: { name: string } } }>;
    comment?: { total: number; comments: JiraComment[] };
    changelog?: { histories: JiraChangelogEntry[] };
    [key: string]: unknown;
  };
}

export interface JiraComment {
  id: string;
  author: { accountId: string; displayName: string };
  body: unknown; // ADF (Atlassian Document Format) or string
  created: string;
  updated: string;
}

export interface JiraChangelogEntry {
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

export interface JiraSprint {
  id: number;
  self: string;
  state: "active" | "closed" | "future";
  name: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
}

export interface JiraBoard {
  id: number;
  self: string;
  name: string;
  type: string;
  location?: { projectKey: string; projectName: string };
}

interface SearchResult {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

/**
 * Create a Jira API client.
 */
export function createJiraClient(instanceUrl: string, email: string, apiToken: string) {
  const baseUrl = instanceUrl.replace(/\/$/, "");
  const authHeader = `Basic ${btoa(`${email}:${apiToken}`)}`;

  async function jiraFetch<T>(
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
        "User-Agent": "openchief-connector-jira",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira API ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json() as Promise<T>;
  }

  return {
    /**
     * Search issues using JQL, with changelog expansion for detecting transitions.
     * Returns paginated results.
     */
    async searchIssues(
      jql: string,
      opts: { startAt?: number; maxResults?: number; expand?: string[] } = {}
    ): Promise<SearchResult> {
      const { startAt = 0, maxResults = 50, expand = ["changelog"] } = opts;
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
            "fixVersions",
            "resolution",
            "created",
            "updated",
            "resolutiondate",
            "duedate",
            "parent",
            "subtasks",
            "comment",
          ];
      const params = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(maxResults),
        fields: fields.join(","),
        expand: expand.join(","),
      });
      return jiraFetch<SearchResult>(`/rest/api/3/search/jql?${params}`);
    },

    /**
     * Get all boards accessible to the user (Jira Software / Agile API).
     */
    async getBoards(projectKey?: string): Promise<JiraBoard[]> {
      const params = new URLSearchParams({ maxResults: "50" });
      if (projectKey) params.set("projectKeyOrId", projectKey);

      const result = await jiraFetch<{ values: JiraBoard[] }>(
        `${baseUrl}/rest/agile/1.0/board?${params}`
      );
      return result.values || [];
    },

    /**
     * Get sprints for a board, optionally filtered by state.
     */
    async getSprints(
      boardId: number,
      state?: "active" | "closed" | "future"
    ): Promise<JiraSprint[]> {
      const params = new URLSearchParams({ maxResults: "50" });
      if (state) params.set("state", state);

      const result = await jiraFetch<{ values: JiraSprint[] }>(
        `${baseUrl}/rest/agile/1.0/board/${boardId}/sprint?${params}`
      );
      return result.values || [];
    },

    /**
     * Get issue comments (paginated).
     */
    async getComments(
      issueKey: string,
      opts: { startAt?: number; maxResults?: number } = {}
    ): Promise<{ total: number; comments: JiraComment[] }> {
      const { startAt = 0, maxResults = 50 } = opts;
      return jiraFetch<{ total: number; comments: JiraComment[] }>(
        `/rest/api/3/issue/${issueKey}/comment?startAt=${startAt}&maxResults=${maxResults}`
      );
    },
  };
}

export type JiraClient = ReturnType<typeof createJiraClient>;
