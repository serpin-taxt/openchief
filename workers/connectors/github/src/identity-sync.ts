/**
 * Sync GitHub user profiles into the D1 identity_mappings table.
 *
 * Discovery strategy (in priority order):
 *   1. GET /orgs/{org}/members — fastest, gets all org members at once
 *      (requires Organization members: read permission on the GitHub App)
 *   2. GET /installation/repositories — list ALL repos the app can see,
 *      then fetch contributors from each (works with default repo permissions)
 *
 * After collecting unique logins, fetches each user's full profile and
 * upserts into identity_mappings. Matches by email to link GitHub usernames
 * to existing Slack identities.
 */

import { generateULID } from "@openchief/shared";
import { getInstallationToken } from "./github-app-auth";

interface GitHubUser {
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
  type: string; // "User" or "Bot"
}

interface IdentitySyncEnv {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_REPOS: string;
  DB: D1Database;
}

export async function syncGitHubIdentities(
  env: IdentitySyncEnv,
): Promise<{ synced: number; skipped: number }> {
  const token = await getInstallationToken(env);

  // 1. Discover all unique user logins
  const userLogins = await discoverOrgUsers(env.GITHUB_REPOS, token);

  console.log(`GitHub identity sync: ${userLogins.size} unique users discovered`);

  // 2. Fetch full profile for each unique user
  const users: GitHubUser[] = [];
  for (const login of userLogins) {
    try {
      const profile = await fetchUserProfile(login, token);
      users.push(profile);
    } catch (err) {
      console.warn(`Failed to fetch profile for ${login}:`, err);
    }
  }

  // 3. Upsert into identity_mappings
  let synced = 0;
  let skipped = 0;

  for (const user of users) {
    if (user.type === "Bot") {
      skipped++;
      continue;
    }

    const now = new Date().toISOString();
    const realName = user.name || user.login;

    try {
      // Tier 1: Match by github_username
      const existingByGH = await env.DB
        .prepare("SELECT id FROM identity_mappings WHERE github_username = ?")
        .bind(user.login)
        .first();

      if (existingByGH) {
        // Use COALESCE so we never overwrite a good Slack-sourced name
        // with a GitHub username fallback
        await env.DB
          .prepare(
            `UPDATE identity_mappings
             SET real_name = COALESCE(?, real_name),
                 avatar_url = COALESCE(avatar_url, ?),
                 is_active = 1, updated_at = ?
             ${user.email ? ", email = COALESCE(email, ?)" : ""}
             WHERE github_username = ?`,
          )
          .bind(
            ...[
              user.name, // null if GitHub has no real name — preserves existing
              user.avatar_url || null,
              now,
              ...(user.email ? [user.email] : []),
              user.login,
            ],
          )
          .run();
        synced++;
        continue;
      }

      // Tier 2: Match by email (links GitHub username to existing Slack identity)
      if (user.email) {
        const existingByEmail = await env.DB
          .prepare("SELECT id FROM identity_mappings WHERE email = ?")
          .bind(user.email)
          .first();

        if (existingByEmail) {
          await env.DB
            .prepare(
              `UPDATE identity_mappings
               SET github_username = ?, real_name = COALESCE(?, real_name),
                   avatar_url = COALESCE(avatar_url, ?), is_active = 1, updated_at = ?
               WHERE email = ?`,
            )
            .bind(
              user.login,
              user.name, // only override if GitHub has a real name (not login fallback)
              user.avatar_url || null,
              now,
              user.email,
            )
            .run();
          synced++;
          continue;
        }
      }

      // Tier 3: Insert new identity
      // display_name is left null — Slack sync will populate it later.
      // real_name uses GitHub's display name if available, else the login.
      await env.DB
        .prepare(
          `INSERT INTO identity_mappings
           (id, github_username, email, real_name, display_name, avatar_url, is_bot, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
        )
        .bind(
          generateULID(),
          user.login,
          user.email || null,
          realName,
          user.name || null, // only set if GitHub has a real name, not the username
          user.avatar_url || null,
          now,
          now,
        )
        .run();
      synced++;
    } catch (err) {
      console.error(`Failed to sync identity for ${user.login}:`, err);
      skipped++;
    }
  }

  return { synced, skipped };
}

// ---------------------------------------------------------------------------
// User discovery
// ---------------------------------------------------------------------------

/**
 * Discover all users associated with the GitHub org/repos.
 *
 * Strategy:
 *   1. Try org members endpoint (fast, one call per org)
 *   2. If that fails (403 — no members:read permission), list ALL repos
 *      the app installation can see and fetch contributors from each
 */
async function discoverOrgUsers(
  githubRepos: string,
  token: string,
): Promise<Set<string>> {
  const userLogins = new Set<string>();

  // Extract unique org names from GITHUB_REPOS
  const configuredRepos = githubRepos.split(",").map((r) => r.trim()).filter(Boolean);
  const orgs = new Set(configuredRepos.map((r) => r.split("/")[0]));

  // Strategy 1: Try org members for each org
  let orgMembersWorked = false;
  for (const org of orgs) {
    try {
      const members = await paginateGitHub<{ login: string; type: string }>(
        `https://api.github.com/orgs/${org}/members?per_page=100`,
        token,
      );
      for (const m of members) {
        if (m.type === "User") userLogins.add(m.login);
      }
      console.log(`Org members for ${org}: ${members.length} members`);
      orgMembersWorked = true;
    } catch (err) {
      console.log(`Org members endpoint failed for ${org} (likely needs members:read permission), falling back to repo contributors`);
    }
  }

  if (orgMembersWorked && userLogins.size > 0) {
    return userLogins;
  }

  // Strategy 2: List all repos the app can see, fetch contributors from each
  console.log("Falling back to installation repos + contributors");
  const repos = await fetchInstallationRepos(token);
  console.log(`Installation has access to ${repos.length} repos`);

  for (const repo of repos) {
    try {
      const contributors = await paginateGitHub<{ login: string; type: string }>(
        `https://api.github.com/repos/${repo}/contributors?per_page=100`,
        token,
        3, // limit pages per repo to control API usage
      );
      for (const c of contributors) {
        if (c.type === "User") userLogins.add(c.login);
      }
    } catch (err) {
      console.warn(`Failed to fetch contributors for ${repo}:`, err);
    }
  }

  return userLogins;
}

/**
 * List all repositories the GitHub App installation can access.
 * Returns full repo names like "org/repo".
 */
async function fetchInstallationRepos(token: string): Promise<string[]> {
  const repos: string[] = [];
  let url: string | null = "https://api.github.com/installation/repositories?per_page=100";
  let page = 0;

  while (url && page < 10) {
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);

    const data = (await res.json()) as {
      repositories: Array<{ full_name: string; fork: boolean; archived: boolean }>;
    };
    for (const r of data.repositories) {
      // Skip forks and archived repos — unlikely to have unique contributors
      if (!r.fork && !r.archived) {
        repos.push(r.full_name);
      }
    }

    const link = res.headers.get("link");
    const nextMatch = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    page++;
  }

  return repos;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function fetchUserProfile(
  login: string,
  token: string,
): Promise<GitHubUser> {
  const res = await fetch(`https://api.github.com/users/${login}`, {
    headers: ghHeaders(token),
  });

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for user ${login}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return {
    login: data.login as string,
    name: (data.name as string) || null,
    email: (data.email as string) || null,
    avatar_url: data.avatar_url as string,
    type: data.type as string,
  };
}

async function paginateGitHub<T>(
  baseUrl: string,
  token: string,
  maxPages = 10,
): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = baseUrl;
  let page = 0;

  while (url && page < maxPages) {
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);

    const data = (await res.json()) as T[];
    all.push(...data);

    const link = res.headers.get("link");
    const nextMatch = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    page++;
  }

  return all;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openchief-connector-github",
  };
}
