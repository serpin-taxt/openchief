/**
 * OpenChief Figma Connector
 *
 * Receives Figma webhook events (passcode-verified), normalizes them to
 * OpenChiefEvent format, and publishes to the openchief-events queue.
 *
 * Also runs periodic polling via cron to check for file version changes.
 */

import { normalizeWebhookEvent, createFileActivityEvent } from "./normalize";

interface Env {
  EVENTS_QUEUE: Queue;
  FIGMA_TOKEN: string;
  FIGMA_PASSCODE: string;
  ADMIN_SECRET: string;
  FIGMA_CLIENT_ID: string;
  FIGMA_CLIENT_SECRET: string;
  FIGMA_TEAM_ID?: string;
  KV: KVNamespace;
  DB: D1Database;
}

function requireAdmin(request: Request, env: Env): Response | null {
  const auth = request.headers.get("Authorization");
  if (!env.ADMIN_SECRET || auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // POST /poll — manual trigger for polling (admin only)
    if (url.pathname === "/poll" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const result = await runPollTasks(env);
        return jsonResponse({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Poll failed";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // POST /backfill — deep backfill (admin only), default 7 days
    if (url.pathname === "/backfill" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const days = Number(url.searchParams.get("days") || "7");
        const result = await runBackfill(env, days);
        return jsonResponse({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Backfill failed";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // GET /projects — list available files and selected file keys (admin only)
    if (url.pathname === "/projects" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const teamId = env.FIGMA_TEAM_ID;
        if (!teamId) {
          return jsonResponse({
            ok: false,
            error: "Team ID not configured. Set FIGMA_TEAM_ID in the Configuration section.",
          }, 400);
        }
        const token = await getFigmaToken(env);
        // First get projects, then get files within each project
        const teamProjects = await figmaApi<{ projects: FigmaProject[] }>(
          `/v1/teams/${teamId}/projects`,
          token,
        );
        const projects = teamProjects?.projects ?? [];
        const allFiles: Array<{ key: string; name: string; projectId: string; projectName: string }> = [];
        for (const project of projects) {
          const projectFiles = await figmaApi<{ files: FigmaFile[] }>(
            `/v1/projects/${project.id}/files`,
            token,
          );
          if (projectFiles?.files) {
            for (const f of projectFiles.files) {
              allFiles.push({
                key: f.key,
                name: f.name,
                projectId: project.id,
                projectName: project.name,
              });
            }
          }
          await delay(300);
        }
        // Read selected file keys from KV
        const selectedKeys = await getFileKeys(env);
        return jsonResponse({ ok: true, teamId, files: allFiles, selected: selectedKeys });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to list files";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // PUT /projects — save selected file keys (admin only)
    if (url.pathname === "/projects" && request.method === "PUT") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const body = await request.json() as { fileKeys: string[] };
        if (!Array.isArray(body.fileKeys)) {
          return jsonResponse({ ok: false, error: "fileKeys must be an array" }, 400);
        }
        // Save selected file keys — this is what getWatchedFiles() reads first
        if (body.fileKeys.length > 0) {
          await env.KV.put("figma:file_keys", JSON.stringify(body.fileKeys));
        } else {
          await env.KV.delete("figma:file_keys");
        }
        return jsonResponse({ ok: true, fileKeys: body.fileKeys });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to save file selection";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // POST /webhook — Figma webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      // Verify passcode — Figma sends this in every webhook payload
      if (payload.passcode !== env.FIGMA_PASSCODE) {
        console.error("Invalid Figma passcode");
        return new Response("Invalid passcode", { status: 401 });
      }

      // Process in background for fast response
      ctx.waitUntil(handleWebhookEvent(payload, env));

      return new Response("ok", { status: 200 });
    }

    // GET /oauth/start — redirect to Figma OAuth authorize page (admin only)
    if (url.pathname === "/oauth/start" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const redirectUri = `${url.origin}/oauth/callback`;
      const scopes = "file_content:read,file_metadata:read,file_versions:read,file_comments:read,library_assets:read,library_content:read,team_library_content:read,file_dev_resources:read,projects:read,webhooks:read,webhooks:write";
      const authorizeUrl = `https://www.figma.com/oauth?client_id=${env.FIGMA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&response_type=code&state=openchief`;
      return Response.redirect(authorizeUrl, 302);
    }

    // GET /oauth/callback — exchange code for token
    if (url.pathname === "/oauth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || state !== "openchief") {
        return new Response("Missing code or invalid state", { status: 400 });
      }

      const redirectUri = `${url.origin}/oauth/callback`;
      const basicAuth = btoa(`${env.FIGMA_CLIENT_ID}:${env.FIGMA_CLIENT_SECRET}`);

      const tokenResp = await fetch("https://api.figma.com/v1/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          redirect_uri: redirectUri,
          code,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenResp.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };

      if (!tokenResp.ok || !tokenData.access_token) {
        return jsonResponse({ error: "Token exchange failed", details: tokenData }, 500);
      }

      // Store the new token and refresh token in KV
      await env.KV.put("figma:oauth_token", tokenData.access_token, {
        expirationTtl: tokenData.expires_in || 86400 * 90,
      });
      if (tokenData.refresh_token) {
        await env.KV.put("figma:refresh_token", tokenData.refresh_token);
      }

      return new Response(
        `<html><body><h1>Figma OAuth Success!</h1><p>Token stored. You can close this tab.</p><pre>Expires in: ${tokenData.expires_in}s</pre></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse({
        service: "openchief-connector-figma",
        status: "ok",
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Scheduled handler — runs every 6 hours
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ) {
    try {
      const result = await runPollTasks(env);
      console.log("Figma poll complete:", JSON.stringify(result));
    } catch (err) {
      console.error(
        "Figma poll failed:",
        err instanceof Error ? err.message : err
      );
    }
  },
};

// --- Webhook Processing ---

async function handleWebhookEvent(
  payload: Record<string, unknown>,
  env: Env
): Promise<void> {
  try {
    // File filtering — skip events from files not in the watched list
    const watchedKeys = await getFileKeys(env);
    if (watchedKeys.length > 0 && payload.file_key) {
      const keySet = new Set(watchedKeys);
      if (!keySet.has(payload.file_key as string)) {
        console.log(
          `Skipping webhook for untracked file: ${payload.file_key} (${payload.event_type})`,
        );
        return;
      }
    }

    const events = normalizeWebhookEvent(payload as any);

    for (const event of events) {
      await env.EVENTS_QUEUE.send(event);
    }

    if (events.length > 0) {
      console.log(
        `Processed ${events.length} Figma event(s): ${events.map((e) => e.eventType).join(", ")}`
      );
    }
  } catch (err) {
    console.error("Figma event processing error:", err);
  }
}

// --- Polling ---

interface FigmaProject {
  id: string;
  name: string;
}

interface FigmaFile {
  key: string;
  name: string;
  last_modified: string;
}

interface FigmaVersion {
  id: string;
  created_at: string;
  label: string;
  description: string;
  user: { id: string; handle: string };
}

/**
 * Get the list of files to watch. Uses figma:file_keys allowlist if set,
 * otherwise falls back to scanning all project files.
 */
async function getWatchedFiles(env: Env, token?: string): Promise<FigmaFile[]> {
  if (!token) token = await getFigmaToken(env);
  // Check for explicit file key allowlist first
  const fileKeysRaw = await env.KV.get("figma:file_keys");
  if (fileKeysRaw) {
    let keys: string[];
    try {
      keys = JSON.parse(fileKeysRaw) as string[];
    } catch {
      keys = fileKeysRaw.split(",").map((s) => s.trim()).filter(Boolean);
    }

    // Try to resolve file metadata from project files list (cheaper than full file endpoint)
    const projectIds = await getProjectIds(env);
    const projectFiles = new Map<string, FigmaFile>();
    for (const projectId of projectIds) {
      const project = await figmaApi<{ files: FigmaFile[] }>(
        `/v1/projects/${projectId}/files`,
        token
      );
      if (project?.files) {
        for (const f of project.files) {
          projectFiles.set(f.key, f);
        }
      }
    }

    // Match allowlisted keys against project files
    const files: FigmaFile[] = [];
    for (const key of keys) {
      const fromProject = projectFiles.get(key);
      if (fromProject) {
        files.push(fromProject);
      } else {
        // Fallback: fetch file metadata directly (lightweight — returns name + lastModified in root)
        const fileMeta = await figmaApi<{ name: string; lastModified: string }>(
          `/v1/files/${key}?depth=1`,
          token
        );
        if (fileMeta) {
          files.push({ key, name: fileMeta.name, last_modified: fileMeta.lastModified });
        }
        await delay(300);
      }
    }
    return files;
  }

  // Fallback: scan all project files
  const projectIds = await getProjectIds(env);
  const allFiles: FigmaFile[] = [];
  for (const projectId of projectIds) {
    const project = await figmaApi<{ files: FigmaFile[] }>(
      `/v1/projects/${projectId}/files`,
      token
    );
    if (project?.files) allFiles.push(...project.files);
  }
  return allFiles;
}

async function runPollTasks(env: Env): Promise<{
  files: number;
  newVersions: number;
  fileEdits: number;
}> {
  const token = await getFigmaToken(env);
  const files = await getWatchedFiles(env, token);
  if (files.length === 0) {
    console.log("No Figma files to watch — set figma:file_keys or figma:project_ids in KV");
    return { files: 0, newVersions: 0, fileEdits: 0 };
  }

  let totalNewVersions = 0;
  let totalFileEdits = 0;

  for (const file of files) {
    // Check for new versions since last poll
    const lastPollKey = `figma:last_poll:${file.key}`;
    const lastPoll = await env.KV.get(lastPollKey);
    const lastPollTime = lastPoll
      ? new Date(lastPoll)
      : new Date(Date.now() - 6 * 60 * 60 * 1000); // Default: 6 hours ago

    // --- Detect file activity (autosaves) via last_modified ---
    const lastModifiedKey = `figma:last_modified:${file.key}`;
    const storedLastModified = await env.KV.get(lastModifiedKey);
    const fileWasEdited = storedLastModified && file.last_modified !== storedLastModified;

    // Get version history
    const versions = await figmaApi<{ versions: FigmaVersion[] }>(
      `/v1/files/${file.key}/versions`,
      token
    );

    if (!versions?.versions) continue;

    // Filter to new versions
    const newVersions = versions.versions.filter(
      (v) => new Date(v.created_at) > lastPollTime
    );

    for (const version of newVersions) {
      const events = normalizeWebhookEvent({
        event_type: "FILE_VERSION_UPDATE",
        passcode: env.FIGMA_PASSCODE,
        timestamp: version.created_at,
        webhook_id: "poll",
        file_key: file.key,
        file_name: file.name,
        version_id: version.id,
        label: version.label,
        description: version.description,
        triggered_by: version.user,
      });

      for (const event of events) {
        await env.EVENTS_QUEUE.send(event);
      }
      totalNewVersions += events.length;
    }

    // Emit file.edited event if last_modified changed but no named version was saved
    // This catches autosave-level edits (someone was working on the file)
    if (fileWasEdited && newVersions.length === 0) {
      // Use recent version users as a proxy for who might be editing
      const recentEditors: Array<{ id: string; handle: string }> = [];
      const seenUsers = new Set<string>();
      for (const v of versions.versions.slice(0, 5)) {
        if (v.user && !seenUsers.has(v.user.id)) {
          seenUsers.add(v.user.id);
          recentEditors.push(v.user);
        }
      }

      const event = createFileActivityEvent({
        fileKey: file.key,
        fileName: file.name,
        lastModified: file.last_modified,
        editors: recentEditors,
      });
      await env.EVENTS_QUEUE.send(event);
      totalFileEdits++;

      console.log(
        `Detected file activity on "${file.name}" — last_modified changed from ${storedLastModified} to ${file.last_modified}`
      );
    }

    // Store current last_modified for next poll comparison
    await env.KV.put(lastModifiedKey, file.last_modified, {
      expirationTtl: 86400 * 30, // 30 days
    });

    // Update last poll time
    await env.KV.put(lastPollKey, new Date().toISOString(), {
      expirationTtl: 86400 * 7, // 7 days
    });

    // Rate limit — don't hammer Figma API
    await delay(500);
  }

  return { files: files.length, newVersions: totalNewVersions, fileEdits: totalFileEdits };
}

// --- Backfill ---

interface FigmaComment {
  id: string;
  message: string;
  created_at: string;
  resolved_at: string | null;
  user: { id: string; handle: string };
  file_key: string;
  parent_id: string;
  order_id: string;
}

async function runBackfill(
  env: Env,
  days: number
): Promise<{
  files: number;
  versions: number;
  comments: number;
}> {
  const token = await getFigmaToken(env);
  const files = await getWatchedFiles(env, token);
  if (files.length === 0) {
    return { files: 0, versions: 0, comments: 0 };
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let totalVersions = 0;
  let totalComments = 0;

  {
    for (const file of files) {
      // --- Versions ---
      const versions = await figmaApi<{ versions: FigmaVersion[] }>(
        `/v1/files/${file.key}/versions`,
        token
      );

      if (versions?.versions) {
        const recent = versions.versions.filter(
          (v) => new Date(v.created_at) > cutoff
        );
        for (const version of recent) {
          const events = normalizeWebhookEvent({
            event_type: "FILE_VERSION_UPDATE",
            passcode: env.FIGMA_PASSCODE,
            timestamp: version.created_at,
            webhook_id: "backfill",
            file_key: file.key,
            file_name: file.name,
            version_id: version.id,
            label: version.label,
            description: version.description,
            triggered_by: version.user,
          });
          for (const event of events) {
            await env.EVENTS_QUEUE.send(event);
          }
          totalVersions += events.length;
        }
      }

      await delay(500);

      // --- Comments ---
      const comments = await figmaApi<{ comments: FigmaComment[] }>(
        `/v1/files/${file.key}/comments`,
        token
      );

      if (comments?.comments) {
        const recent = comments.comments.filter(
          (c) => new Date(c.created_at) > cutoff
        );
        for (const c of recent) {
          const events = normalizeWebhookEvent({
            event_type: "FILE_COMMENT",
            passcode: env.FIGMA_PASSCODE,
            timestamp: c.created_at,
            webhook_id: "backfill",
            file_key: file.key,
            file_name: file.name,
            comment: [
              {
                id: c.id,
                text: c.message,
                user: c.user,
                created_at: c.created_at,
                parent_id: c.parent_id || undefined,
                file_key: file.key,
                file_name: file.name,
              },
            ],
          });
          for (const event of events) {
            await env.EVENTS_QUEUE.send(event);
          }
          totalComments += events.length;
        }
      }

      await delay(500);
    }
  }

  // Update last poll times so regular poll doesn't re-fetch
  for (const file of files) {
    await env.KV.put(
      `figma:last_poll:${file.key}`,
      new Date().toISOString(),
      { expirationTtl: 86400 * 7 }
    );
  }

  return {
    files: files.length,
    versions: totalVersions,
    comments: totalComments,
  };
}


async function getProjectIds(env: Env): Promise<string[]> {
  const raw = await env.KV.get("figma:project_ids");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    // If it's a comma-separated string
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

async function getFileKeys(env: Env): Promise<string[]> {
  const raw = await env.KV.get("figma:file_keys");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

/**
 * Get the best available Figma token — prefer OAuth token from KV, fall back to env secret.
 */
async function getFigmaToken(env: Env): Promise<string> {
  const oauthToken = await env.KV.get("figma:oauth_token");
  return oauthToken || env.FIGMA_TOKEN;
}

async function figmaApi<T>(path: string, token: string): Promise<T | null> {
  try {
    // OAuth tokens (figu_*) use Bearer auth; personal tokens (figd_*) use X-Figma-Token
    const isOAuth = token.startsWith("figu_");
    const headers: Record<string, string> = isOAuth
      ? { Authorization: `Bearer ${token}` }
      : { "X-Figma-Token": token };

    const resp = await fetch(`https://api.figma.com${path}`, { headers });
    if (!resp.ok) {
      console.error(`Figma API ${path} failed: ${resp.status} ${resp.statusText}`);
      return null;
    }
    return (await resp.json()) as T;
  } catch (err) {
    console.error(`Figma API ${path} error:`, err);
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
