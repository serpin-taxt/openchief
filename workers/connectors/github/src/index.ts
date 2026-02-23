import { normalizeGitHubEvent } from "./normalize";
import { verifyGitHubSignature } from "./webhook-verify";
import { pollAllRepos } from "./poll";
import { syncGitHubIdentities } from "./identity-sync";

interface Env {
  EVENTS_QUEUE: Queue;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_REPOS: string;
  ADMIN_SECRET: string;
  POLL_CURSOR: KVNamespace;
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET / -- health check
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "openchief-connector-github",
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // POST /poll -- manual trigger for polling (admin only)
    // ?task=identity  — only sync user profiles (for "Sync Humans" button)
    if (url.pathname === "/poll" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const task = url.searchParams.get("task");
      try {
        if (task === "identity") {
          const result = await syncGitHubIdentities(env);
          return Response.json({ ok: true, result: { userSync: result } });
        }
        const results = await pollAllRepos(env);
        return Response.json({ ok: true, results });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Poll failed";
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    // All other POST requests are webhook deliveries
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.text();

    // Verify webhook signature
    const signature = request.headers.get("x-hub-signature-256");
    const valid = await verifyGitHubSignature(
      body,
      signature,
      env.GITHUB_WEBHOOK_SECRET
    );
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const eventType = request.headers.get("x-github-event");
    if (!eventType) {
      return new Response("Missing event type", { status: 400 });
    }

    // Skip ping events
    if (eventType === "ping") {
      return new Response("pong", { status: 200 });
    }

    const payload = JSON.parse(body) as Record<string, unknown>;
    const events = normalizeGitHubEvent(eventType, payload);

    // Publish all normalized events to the queue
    for (const event of events) {
      await env.EVENTS_QUEUE.send(event);
    }

    return new Response(JSON.stringify({ received: events.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },

  // Scheduled handler -- polls GitHub API every 6 hours for recent activity
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ) {
    try {
      const results = await pollAllRepos(env);
      console.log("Poll complete:", JSON.stringify(results));
    } catch (err) {
      console.error(
        "Poll failed:",
        err instanceof Error ? err.message : err
      );
    }
  },
};
