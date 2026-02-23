// ---------------------------------------------------------------------------
// API type definitions
// ---------------------------------------------------------------------------

export type UserRole = "superadmin" | "exec" | null;

export interface CurrentUser {
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  team: string | null;
  role: UserRole;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  userEmail?: string;
  userName?: string;
  timestamp?: string;
}

export interface EventVolumeBucket {
  source: string;
  date: string;
  count: number;
}

export interface ConnectionStatus {
  source: string;
  label: string;
  icon: string;
  lastEventAt: string | null;
  eventCount: number;
  connectionType: string;
  description: string | null;
}

export interface ConnectionEvent {
  id: string;
  source: string;
  eventType: string;
  actor: string | null;
  project: string | null;
  summary: string;
  timestamp: string;
  tags: string[];
}

export interface Identity {
  id: string;
  githubUsername: string | null;
  slackUserId: string | null;
  figmaHandle: string | null;
  discordHandle: string | null;
  email: string | null;
  realName: string;
  displayName: string | null;
  team: string | null;
  role: string | null;
  avatarUrl: string | null;
  isBot: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorConfigField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder: string | null;
  description: string | null;
  configured: boolean;
  maskedValue: string | null;
  updatedAt: string | null;
}

export interface ConnectorConfigResponse {
  source: string;
  label: string;
  icon: string;
  workerName: string;
  fields: ConnectorConfigField[];
}

export interface JobStatus {
  agentId: string;
  agentName: string;
  expectedReports: Array<{
    reportType: string;
    cadence: string;
    completed: boolean;
    reportId: string | null;
    healthSignal: string | null;
    headline: string | null;
    completedAt: string | null;
    eventCount: number | null;
    nextRunAt: string | null;
  }>;
}

export interface ModelSetting {
  jobType: string;
  modelId: string;
  maxTokens: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SyncResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `/api/${path.replace(/^\//, "")}`;
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    // Redirect on 401 (session expired or missing).
    // For password auth this goes to /login; for Cloudflare Access a full
    // reload of the current page will trigger the Access login flow.
    if (res.status === 401 && !path.startsWith("auth/")) {
      // Reload to let the auth context + RequireAuth handle the redirect
      // appropriately for the active provider.
      window.location.reload();
      throw new ApiError(401, "Session expired");
    }
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, text);
  }
  // Handle 204 No Content
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>("GET", path);
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("POST", path, body);
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("PUT", path, body);
  },
  delete<T>(path: string): Promise<T> {
    return request<T>("DELETE", path);
  },
};

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Parse a Server-Sent Events stream from a fetch Response.
 * Yields parsed SSE events as they arrive.
 *
 * Usage:
 * ```ts
 * const res = await fetch("/api/chat", { method: "POST", body: ... });
 * for await (const evt of parseSSEStream(res)) {
 *   if (evt.event === "delta") { ... }
 * }
 * ```
 */
export async function* parseSSEStream(
  response: Response,
): AsyncGenerator<SSEEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double newlines (SSE event boundary)
      const parts = buffer.split("\n\n");
      // Keep the last part as it may be incomplete
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;

        let eventType = "message";
        let data = "";

        for (const line of part.split("\n")) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data += (data ? "\n" : "") + line.slice(5).trim();
          }
        }

        if (data) {
          yield { event: eventType, data };
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      let eventType = "message";
      let data = "";

      for (const line of buffer.split("\n")) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += (data ? "\n" : "") + line.slice(5).trim();
        }
      }

      if (data) {
        yield { event: eventType, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
