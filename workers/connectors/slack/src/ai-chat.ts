/**
 * Slack AI Split-View Chat
 *
 * Handles the "Agents & AI Apps" feature — lets users chat with OpenChief agents
 * directly in Slack's split-view panel. Relays messages to the runtime's existing
 * /chat/:agentId SSE endpoint and streams responses back via Slack's streaming APIs.
 */

import { resolveUser } from "./user-cache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiChatEnv {
  SLACK_BOT_TOKEN: string;
  KV: KVNamespace;
  DB: D1Database;
  AGENT_RUNTIME: Fetcher;
  RUNTIME_ADMIN_SECRET: string;
  SUPERADMIN_EMAIL?: string;
}

interface AssistantThread {
  user_id: string;
  channel_id: string; // DM channel where thread lives
  thread_ts: string;
  context?: {
    channel_id?: string; // Channel user is currently viewing
    team_id?: string;
    enterprise_id?: string;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THREAD_AGENT_TTL = 7 * 24 * 3600; // 7 days
const STREAM_FLUSH_INTERVAL_MS = 3000; // 3 seconds
const STREAM_BUFFER_MAX_CHARS = 500;

/** Domain-specific starter messages per agent. Used as suggested prompts. */
const AGENT_STARTERS: Record<string, string> = {
  ceo: "What's the big picture today?",
  "eng-manager": "How's engineering velocity looking?",
  "product-manager": "What's the product pulse?",
  "design-manager": "What's happening in design?",
  "data-analyst": "What do the metrics look like?",
  "customer-support": "What are customers saying?",
  cfo: "How are the financials?",
  ciso: "Any security concerns?",
  "marketing-manager": "What's our marketing performance?",
  "community-manager": "How's the community doing?",
  researcher: "What industry trends should we know about?",
  bizdev: "Any partnership updates?",
  cro: "How's revenue tracking?",
  "hr-manager": "What's the team health?",
  "qa-manager": "What's the quality status?",
};

// ---------------------------------------------------------------------------
// Access control helpers
// ---------------------------------------------------------------------------

/**
 * Check if a Slack user has exec-level access.
 * Resolves the user's email from Slack, then checks identity_mappings for
 * role = 'exec' or matches the SUPERADMIN_EMAIL.
 */
async function isUserExec(
  userId: string,
  env: AiChatEnv
): Promise<{ isExec: boolean; email: string | null; displayName: string | null }> {
  const userInfo = await resolveUser(userId, env.KV, env.SLACK_BOT_TOKEN);
  const email = userInfo.email || null;
  const displayName = userInfo.displayName || userInfo.realName;

  // Superadmin always has exec access
  if (email && env.SUPERADMIN_EMAIL && email.toLowerCase() === env.SUPERADMIN_EMAIL.toLowerCase()) {
    return { isExec: true, email, displayName };
  }

  // Check identity_mappings for exec role
  if (email) {
    const { results } = await env.DB.prepare(
      "SELECT role FROM identity_mappings WHERE email = ? AND role = 'exec' LIMIT 1"
    ).bind(email).all<{ role: string }>();
    if (results.length > 0) {
      return { isExec: true, email, displayName };
    }
  }

  // Also check by slack user ID in case email didn't match
  const { results: slackResults } = await env.DB.prepare(
    "SELECT role FROM identity_mappings WHERE slack_user_id = ? AND role = 'exec' LIMIT 1"
  ).bind(userId).all<{ role: string }>();
  if (slackResults.length > 0) {
    return { isExec: true, email, displayName };
  }

  return { isExec: false, email, displayName };
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

function threadKey(channelId: string, threadTs: string): string {
  return `slack:ai:thread:${channelId}:${threadTs}`;
}

async function getThreadAgent(
  channelId: string,
  threadTs: string,
  kv: KVNamespace
): Promise<string | null> {
  return kv.get(threadKey(channelId, threadTs));
}

async function setThreadAgent(
  channelId: string,
  threadTs: string,
  agentId: string,
  kv: KVNamespace
): Promise<void> {
  await kv.put(threadKey(channelId, threadTs), agentId, {
    expirationTtl: THREAD_AGENT_TTL,
  });
}

// ---------------------------------------------------------------------------
// Slack API helper
// ---------------------------------------------------------------------------

async function slackApi(
  method: string,
  token: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const result = (await resp.json()) as Record<string, unknown>;
  if (!result.ok) {
    console.error(`Slack API ${method} error:`, result.error);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. assistant_thread_started
// ---------------------------------------------------------------------------

export async function handleAssistantThreadStarted(
  event: Record<string, unknown>,
  env: AiChatEnv
): Promise<void> {
  const thread = event.assistant_thread as AssistantThread | undefined;
  if (!thread) return;

  const { channel_id: channelId, thread_ts: threadTs, user_id: userId } = thread;

  // Check user's access level
  const { isExec } = await isUserExec(userId, env);

  // Query enabled agents with visibility info
  const { results: allAgents } = await env.DB.prepare(
    `SELECT id, name, json_extract(config, '$.visibility') as visibility
     FROM agent_definitions WHERE enabled = 1 ORDER BY name ASC`
  ).all<{ id: string; name: string; visibility: string | null }>();

  // Filter out exec-only agents for non-exec users
  const agents = isExec
    ? allAgents
    : allAgents.filter((a) => a.visibility !== "exec");

  if (agents.length === 0) {
    await slackApi("assistant.threads.setStatus", env.SLACK_BOT_TOKEN, {
      channel_id: channelId,
      thread_ts: threadTs,
      status: "No agents available.",
    });
    return;
  }

  // Try to find a context-aware default agent
  let defaultAgent = agents[0];
  const contextChannelId = thread.context?.channel_id;
  if (contextChannelId) {
    const matched = await findContextAgent(contextChannelId, agents, env);
    if (matched) defaultAgent = matched;
  }

  // Build suggested prompts (max 4)
  const promptAgents = [
    defaultAgent,
    ...agents.filter((a) => a.id !== defaultAgent.id),
  ].slice(0, 4);

  const prompts = promptAgents.map((agent) => ({
    title: agent.name,
    message: AGENT_STARTERS[agent.id] || `Talk to ${agent.name}`,
  }));

  // Set prompts and title
  await Promise.all([
    slackApi("assistant.threads.setSuggestedPrompts", env.SLACK_BOT_TOKEN, {
      channel_id: channelId,
      thread_ts: threadTs,
      title: "Which agent would you like to talk to?",
      prompts,
    }),
    slackApi("assistant.threads.setTitle", env.SLACK_BOT_TOKEN, {
      channel_id: channelId,
      thread_ts: threadTs,
      title: "OpenChief",
    }),
  ]);

  // Store default agent for this thread
  await setThreadAgent(channelId, threadTs, defaultAgent.id, env.KV);
}

/**
 * Find the best-matching agent for the channel the user is currently viewing.
 * Looks up channel name from KV cache, then matches against agent subscriptions.
 */
async function findContextAgent(
  contextChannelId: string,
  agents: Array<{ id: string; name: string; visibility?: string | null }>,
  env: AiChatEnv
): Promise<{ id: string; name: string } | null> {
  // Resolve channel name from KV cache
  const channelListRaw = await env.KV.get("slack:channels:list");
  if (!channelListRaw) return null;

  let channelName: string | null = null;
  try {
    const channels = JSON.parse(channelListRaw) as Array<{
      id: string;
      name: string;
    }>;
    const ch = channels.find((c) => c.id === contextChannelId);
    if (ch) channelName = ch.name;
  } catch {
    return null;
  }
  if (!channelName) return null;

  // Query subscriptions that match this channel
  const agentIds = agents.map((a) => a.id);
  const placeholders = agentIds.map(() => "?").join(",");
  const { results: subs } = await env.DB.prepare(
    `SELECT agent_id, scope_filter FROM agent_subscriptions
     WHERE agent_id IN (${placeholders}) AND source = 'slack'`
  ).bind(...agentIds).all<{ agent_id: string; scope_filter: string | null }>();

  // Check which agent's scope_filter.project includes this channel
  for (const sub of subs) {
    if (!sub.scope_filter) continue;
    try {
      const filter = JSON.parse(sub.scope_filter) as {
        project?: string | string[];
      };
      const projects = Array.isArray(filter.project)
        ? filter.project
        : filter.project
          ? [filter.project]
          : [];
      // Match with or without # prefix
      const match = projects.some(
        (p) => p === `#${channelName}` || p === channelName
      );
      if (match) {
        return agents.find((a) => a.id === sub.agent_id) || null;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 2. assistant_thread_context_changed
// ---------------------------------------------------------------------------

export async function handleAssistantThreadContextChanged(
  _event: Record<string, unknown>,
  _env: AiChatEnv
): Promise<void> {
  // V1: no-op. Could update suggested prompts for new channel context later.
}

// ---------------------------------------------------------------------------
// 3. message.im handler
// ---------------------------------------------------------------------------

/**
 * Handle a DM message that might be an assistant thread message.
 * Returns true if handled, false if not an assistant thread (fall through).
 */
export async function handleAssistantMessage(
  event: Record<string, unknown>,
  env: AiChatEnv
): Promise<boolean> {
  const channelId = event.channel as string;
  const threadTs = event.thread_ts as string | undefined;
  const text = (event.text as string) || "";
  const userId = event.user as string;

  // Must be in a thread to be an assistant conversation
  if (!threadTs) return false;

  // Look up whether this thread is tracked as an assistant thread
  const agentId = await getThreadAgent(channelId, threadTs, env.KV);
  if (!agentId) return false;

  // Check if user is switching agents via a suggested prompt
  let activeAgent = agentId;
  for (const [id, starter] of Object.entries(AGENT_STARTERS)) {
    if (text.trim() === starter) {
      activeAgent = id;
      if (activeAgent !== agentId) {
        await setThreadAgent(channelId, threadTs, activeAgent, env.KV);
      }
      break;
    }
  }

  // Show thinking status
  await slackApi("assistant.threads.setStatus", env.SLACK_BOT_TOKEN, {
    channel_id: channelId,
    thread_ts: threadTs,
    status: "is thinking...",
  });

  // Resolve user identity and check access level
  const { isExec, email, displayName } = await isUserExec(userId, env);
  const userEmail = email || `${userId}@slack`;
  const userName = displayName;

  // Check if the selected agent requires exec access
  const { results: agentRows } = await env.DB.prepare(
    "SELECT json_extract(config, '$.visibility') as visibility FROM agent_definitions WHERE id = ?"
  ).bind(activeAgent).all<{ visibility: string | null }>();
  const agentVisibility = agentRows[0]?.visibility;

  if (agentVisibility === "exec" && !isExec) {
    await postFallbackMessage(
      channelId,
      threadTs,
      "Sorry, this agent is restricted to executive team members.",
      env
    );
    return true;
  }

  // Call runtime chat endpoint
  try {
    const runtimeResponse = await env.AGENT_RUNTIME.fetch(
      `https://openchief-runtime/chat/${activeAgent}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.RUNTIME_ADMIN_SECRET}`,
        },
        body: JSON.stringify({
          message: text,
          userEmail,
          userName,
        }),
      }
    );

    if (!runtimeResponse.ok || !runtimeResponse.body) {
      console.error(
        `Runtime chat error: ${runtimeResponse.status} ${runtimeResponse.statusText}`
      );
      await postFallbackMessage(
        channelId,
        threadTs,
        "Sorry, I couldn't reach the agent right now. Please try again.",
        env
      );
      return true;
    }

    // Relay the SSE stream to Slack
    await streamResponseToSlack(
      runtimeResponse.body,
      channelId,
      threadTs,
      env
    );
  } catch (err) {
    console.error("AI chat error:", err);
    await postFallbackMessage(
      channelId,
      threadTs,
      "Sorry, something went wrong. Please try again.",
      env
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Streaming relay: Runtime SSE → Slack streaming APIs
// ---------------------------------------------------------------------------

async function streamResponseToSlack(
  body: ReadableStream<Uint8Array>,
  channelId: string,
  threadTs: string,
  env: AiChatEnv
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let sseBuffer = ""; // Partial SSE line buffer
  let textBuffer = ""; // Text to flush to Slack
  let fullText = ""; // Complete accumulated text
  let streamTs: string | null = null; // Slack message ts from startStream
  let useFallback = false;
  let lastFlushTime = Date.now();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || ""; // Keep incomplete last line

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          // Event type line — we'll parse data on the next line
          continue;
        }

        if (!line.startsWith("data: ")) continue;

        const dataStr = line.slice(6);
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataStr);
        } catch {
          continue;
        }

        const type = data.type as string;

        if (type === "delta" && data.text) {
          const chunk = data.text as string;
          textBuffer += chunk;
          fullText += chunk;

          // Start stream on first text
          if (!streamTs && !useFallback) {
            streamTs = await startSlackStream(channelId, threadTs, chunk, env);
            if (!streamTs) {
              useFallback = true;
            } else {
              textBuffer = ""; // Already sent in startStream
              lastFlushTime = Date.now();
              continue;
            }
          }

          // Flush buffer if large enough or enough time has passed
          if (
            streamTs &&
            (textBuffer.length >= STREAM_BUFFER_MAX_CHARS ||
              Date.now() - lastFlushTime >= STREAM_FLUSH_INTERVAL_MS)
          ) {
            await appendSlackStream(channelId, streamTs, textBuffer, env);
            textBuffer = "";
            lastFlushTime = Date.now();
          }
        } else if (type === "tool_status" && data.tool) {
          const label = (data.status as string) || `Using ${data.tool}...`;
          await slackApi("assistant.threads.setStatus", env.SLACK_BOT_TOKEN, {
            channel_id: channelId,
            thread_ts: threadTs,
            status: label,
          });
        } else if (type === "done") {
          // Flush remaining text
          if (streamTs && textBuffer) {
            await appendSlackStream(channelId, streamTs, textBuffer, env);
            textBuffer = "";
          }
          if (streamTs) {
            await stopSlackStream(channelId, streamTs, env);
          }
          if (useFallback && fullText) {
            await postFallbackMessage(channelId, threadTs, fullText, env);
          }
          return;
        } else if (type === "error") {
          const errText = (data.text as string) || "An error occurred.";
          if (streamTs) {
            if (textBuffer) {
              await appendSlackStream(channelId, streamTs, textBuffer, env);
            }
            await stopSlackStream(channelId, streamTs, env);
          }
          if (!fullText) {
            await postFallbackMessage(channelId, threadTs, errText, env);
          } else if (useFallback) {
            await postFallbackMessage(channelId, threadTs, fullText, env);
          }
          return;
        }
      }
    }

    // Stream ended without explicit "done" — flush what we have
    if (streamTs && textBuffer) {
      await appendSlackStream(channelId, streamTs, textBuffer, env);
    }
    if (streamTs) {
      await stopSlackStream(channelId, streamTs, env);
    }
    if (useFallback && fullText) {
      await postFallbackMessage(channelId, threadTs, fullText, env);
    }
    if (!streamTs && !useFallback && fullText) {
      // Never started streaming — post as fallback
      await postFallbackMessage(channelId, threadTs, fullText, env);
    }
  } catch (err) {
    console.error("Stream relay error:", err);
    // Best-effort: post whatever we accumulated
    if (streamTs) {
      try {
        await stopSlackStream(channelId, streamTs, env);
      } catch { /* ignore */ }
    }
    if (fullText && !streamTs) {
      await postFallbackMessage(channelId, threadTs, fullText, env);
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Slack streaming API wrappers
// ---------------------------------------------------------------------------

async function startSlackStream(
  channelId: string,
  threadTs: string,
  initialText: string,
  env: AiChatEnv
): Promise<string | null> {
  const result = await slackApi("chat.startStream", env.SLACK_BOT_TOKEN, {
    channel: channelId,
    thread_ts: threadTs,
    chunks: [{ type: "markdown_text", markdown_text: initialText }],
  });
  return (result.ts as string) || null;
}

async function appendSlackStream(
  channelId: string,
  messageTs: string,
  text: string,
  env: AiChatEnv
): Promise<void> {
  // Slack limits chunks to 12000 chars
  const maxChunk = 12000;
  for (let i = 0; i < text.length; i += maxChunk) {
    await slackApi("chat.appendStream", env.SLACK_BOT_TOKEN, {
      channel: channelId,
      ts: messageTs,
      chunks: [
        { type: "markdown_text", markdown_text: text.slice(i, i + maxChunk) },
      ],
    });
  }
}

async function stopSlackStream(
  channelId: string,
  messageTs: string,
  env: AiChatEnv
): Promise<void> {
  await slackApi("chat.stopStream", env.SLACK_BOT_TOKEN, {
    channel: channelId,
    ts: messageTs,
  });
}

async function postFallbackMessage(
  channelId: string,
  threadTs: string,
  text: string,
  env: AiChatEnv
): Promise<void> {
  await slackApi("chat.postMessage", env.SLACK_BOT_TOKEN, {
    channel: channelId,
    thread_ts: threadTs,
    text,
  });
}
