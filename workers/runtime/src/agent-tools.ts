/**
 * Data-driven agent tool system.
 *
 * OpenChief reads the `tools` array from each agent's definition.
 * This means any agent can be given any tool via JSON config —
 * no hardcoded agent→tool mappings needed.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolEnv {
  DB: D1Database;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
}

/** All available tool definitions (Anthropic tool_use format). */
const ALL_TOOLS: Record<string, ToolDefinition> = {
  query_events: {
    name: "query_events",
    description:
      "Run a read-only SQL query against the OpenChief events table. " +
      "The table schema: events(id TEXT, timestamp TEXT, ingested_at TEXT, source TEXT, event_type TEXT, " +
      "scope_org TEXT, scope_project TEXT, scope_team TEXT, scope_actor TEXT, summary TEXT, payload TEXT, tags TEXT). " +
      "Only SELECT queries are allowed. Always include a LIMIT clause.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "SQL SELECT query to execute against the events table",
        },
      },
      required: ["query"],
    },
  },

  github_file: {
    name: "github_file",
    description:
      "Fetch a file or list a directory from the configured GitHub repository. " +
      "Provide a path relative to the repo root. For directories, returns a listing of contents.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: 'File or directory path (e.g. "src/index.ts" or "src/")',
        },
        ref: {
          type: "string",
          description: 'Git ref — branch, tag, or SHA (default: "main")',
        },
      },
      required: ["path"],
    },
  },

  github_search: {
    name: "github_search",
    description:
      "Search for code in the configured GitHub repository. " +
      "Returns matching file paths and code snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Code search query",
        },
      },
      required: ["query"],
    },
  },

  query_tasks: {
    name: "query_tasks",
    description:
      "Run a read-only SQL query against the OpenChief tasks table. " +
      "The table schema: tasks(id TEXT, title TEXT, description TEXT, status TEXT, priority INTEGER, " +
      "created_by TEXT, assigned_to TEXT, source_report_id TEXT, output TEXT, context TEXT, " +
      "started_at TEXT, completed_at TEXT, due_by TEXT, tokens_used INTEGER, created_at TEXT, updated_at TEXT). " +
      "Status values: proposed, queued, in_progress, completed, cancelled. " +
      "Only SELECT queries are allowed. Always include a LIMIT clause.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "SQL SELECT query to execute against the tasks table",
        },
      },
      required: ["query"],
    },
  },
};

/**
 * Get tools available to a specific agent — reads from the agent's `tools` array.
 * Fully data-driven — no hardcoded agent-to-tool mapping needed.
 */
export function getAgentTools(toolNames: string[]): ToolDefinition[] {
  if (!toolNames || toolNames.length === 0) return [];

  return toolNames
    .map((name) => ALL_TOOLS[name])
    .filter((t): t is ToolDefinition => t !== undefined);
}

/**
 * Execute a tool and return the result.
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  env: ToolEnv
): Promise<{ content: string; is_error?: boolean }> {
  try {
    switch (toolName) {
      case "query_events":
        return executeQueryEvents(input.query as string, env.DB);

      case "github_file":
        return executeGitHubFile(
          input.path as string,
          (input.ref as string) || "main",
          env.GITHUB_TOKEN,
          env.GITHUB_REPO
        );

      case "github_search":
        return executeGitHubSearch(
          input.query as string,
          env.GITHUB_TOKEN,
          env.GITHUB_REPO
        );

      case "query_tasks":
        return executeQueryTasks(input.query as string, env.DB);

      default:
        return { content: `Unknown tool: ${toolName}`, is_error: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { content: `Tool error: ${message}`, is_error: true };
  }
}

/**
 * Execute a read-only SQL query against the D1 events table.
 */
async function executeQueryEvents(
  query: string,
  db: D1Database
): Promise<{ content: string; is_error?: boolean }> {
  // Safety: only allow SELECT queries
  const normalized = query.trim().toUpperCase();
  if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH")) {
    return {
      content: "Only SELECT/WITH queries are allowed.",
      is_error: true,
    };
  }

  // Block dangerous keywords
  const forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "REPLACE", "ATTACH"];
  for (const word of forbidden) {
    if (normalized.includes(word)) {
      return {
        content: `Forbidden keyword: ${word}. Only read-only queries are allowed.`,
        is_error: true,
      };
    }
  }

  // Enforce LIMIT
  if (!normalized.includes("LIMIT")) {
    return {
      content: "Please add a LIMIT clause to your query (max 100 rows).",
      is_error: true,
    };
  }

  const result = await db.prepare(query).all();
  const rows = result.results || [];

  if (rows.length === 0) {
    return { content: "No results found." };
  }

  // Format as a simple table
  const columns = Object.keys(rows[0] as Record<string, unknown>);
  const header = columns.join(" | ");
  const separator = columns.map(() => "---").join(" | ");
  const body = rows
    .slice(0, 100)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return columns
        .map((col) => {
          const val = r[col];
          if (val === null || val === undefined) return "";
          const str = String(val);
          return str.length > 200 ? str.slice(0, 200) + "..." : str;
        })
        .join(" | ");
    })
    .join("\n");

  const output = `${header}\n${separator}\n${body}`;

  // Truncate if too large
  if (output.length > 15000) {
    return { content: output.slice(0, 15000) + "\n\n... (truncated)" };
  }

  return { content: output };
}

/**
 * Execute a read-only SQL query against the D1 tasks table.
 */
async function executeQueryTasks(
  query: string,
  db: D1Database
): Promise<{ content: string; is_error?: boolean }> {
  // Reuse the same safety checks as query_events
  const normalized = query.trim().toUpperCase();
  if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH")) {
    return {
      content: "Only SELECT/WITH queries are allowed.",
      is_error: true,
    };
  }

  const forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "REPLACE", "ATTACH"];
  for (const word of forbidden) {
    if (normalized.includes(word)) {
      return {
        content: `Forbidden keyword: ${word}. Only read-only queries are allowed.`,
        is_error: true,
      };
    }
  }

  if (!normalized.includes("LIMIT")) {
    return {
      content: "Please add a LIMIT clause to your query (max 100 rows).",
      is_error: true,
    };
  }

  const result = await db.prepare(query).all();
  const rows = result.results || [];

  if (rows.length === 0) {
    return { content: "No results found." };
  }

  const columns = Object.keys(rows[0] as Record<string, unknown>);
  const header = columns.join(" | ");
  const separator = columns.map(() => "---").join(" | ");
  const body = rows
    .slice(0, 100)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return columns
        .map((col) => {
          const val = r[col];
          if (val === null || val === undefined) return "";
          const str = String(val);
          return str.length > 200 ? str.slice(0, 200) + "..." : str;
        })
        .join(" | ");
    })
    .join("\n");

  const output = `${header}\n${separator}\n${body}`;

  if (output.length > 15000) {
    return { content: output.slice(0, 15000) + "\n\n... (truncated)" };
  }

  return { content: output };
}

/**
 * Fetch a file or directory from GitHub.
 */
async function executeGitHubFile(
  path: string,
  ref: string,
  token?: string,
  repo?: string
): Promise<{ content: string; is_error?: boolean }> {
  if (!token || !repo) {
    return {
      content: "GitHub integration is not configured. Set GITHUB_TOKEN and github.repo in your config.",
      is_error: true,
    };
  }

  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "openchief-runtime",
    },
  });

  if (!resp.ok) {
    return {
      content: `GitHub API error: ${resp.status} for ${path}`,
      is_error: true,
    };
  }

  const data = await resp.json();

  // Directory listing
  if (Array.isArray(data)) {
    const listing = (data as Array<{ name: string; type: string; size: number }>)
      .map((item) => `${item.type === "dir" ? "📁" : "📄"} ${item.name} (${formatBytes(item.size)})`)
      .join("\n");
    return { content: `Directory: ${path}\n\n${listing}` };
  }

  // File content
  const file = data as { content?: string; size: number; encoding?: string };
  if (file.encoding === "base64" && file.content) {
    const decoded = atob(file.content.replace(/\n/g, ""));
    if (decoded.length > 20000) {
      return { content: decoded.slice(0, 20000) + "\n\n... (truncated, file is " + formatBytes(file.size) + ")" };
    }
    return { content: decoded };
  }

  return { content: `File: ${path} (${formatBytes(file.size)})` };
}

/**
 * Search code in GitHub repository.
 */
async function executeGitHubSearch(
  query: string,
  token?: string,
  repo?: string
): Promise<{ content: string; is_error?: boolean }> {
  if (!token || !repo) {
    return {
      content: "GitHub integration is not configured.",
      is_error: true,
    };
  }

  const searchQuery = `${query} repo:${repo}`;
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=10`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "openchief-runtime",
    },
  });

  if (!resp.ok) {
    return {
      content: `GitHub search error: ${resp.status}`,
      is_error: true,
    };
  }

  const data = (await resp.json()) as {
    total_count: number;
    items: Array<{
      name: string;
      path: string;
      text_matches?: Array<{ fragment: string }>;
    }>;
  };

  if (data.total_count === 0) {
    return { content: `No results found for "${query}" in ${repo}` };
  }

  const results = data.items
    .map((item) => {
      const snippet = item.text_matches?.[0]?.fragment || "";
      return `📄 ${item.path}\n${snippet ? `   ${snippet.slice(0, 200)}` : ""}`;
    })
    .join("\n\n");

  return {
    content: `Found ${data.total_count} results for "${query}":\n\n${results}`,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
