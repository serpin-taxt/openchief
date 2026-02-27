/**
 * Sync Jira Cloud user profiles into the D1 identity_mappings table.
 *
 * Discovery strategy:
 *   Fetches recently updated issues (last 30 days) and collects unique
 *   Atlassian accountIds from assignee, reporter, and creator fields.
 *   Then upserts each user into identity_mappings using a 3-tier match:
 *     1. By jira_account_id (already linked)
 *     2. By email (links Jira to existing Slack/GitHub identity)
 *     3. Insert new identity
 *
 * Note: Jira Cloud may hide email addresses depending on user privacy settings.
 * When emails are unavailable, new identities are created that can later be
 * merged via the Team page.
 */

import { generateULID } from "@openchief/shared";
import { createJiraClient } from "./jira-api";

interface AtlassianUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrl?: string;
}

interface IdentitySyncEnv {
  JIRA_API_EMAIL: string;
  JIRA_API_TOKEN: string;
  JIRA_INSTANCE_URL: string;
  JIRA_PROJECTS?: string;
  DB: D1Database;
}

export async function syncJiraIdentities(
  env: IdentitySyncEnv,
): Promise<{ synced: number; skipped: number }> {
  const client = createJiraClient(
    env.JIRA_INSTANCE_URL,
    env.JIRA_API_EMAIL,
    env.JIRA_API_TOKEN,
  );

  // 1. Discover unique users from recent issues
  const users = await discoverUsers(client, env.JIRA_PROJECTS);
  console.log(`Jira identity sync: ${users.size} unique users discovered`);

  // 2. Upsert into identity_mappings
  let synced = 0;
  let skipped = 0;

  for (const user of users.values()) {
    try {
      const now = new Date().toISOString();

      // Tier 1: Match by jira_account_id
      const existingByJira = await env.DB
        .prepare("SELECT id FROM identity_mappings WHERE jira_account_id = ?")
        .bind(user.accountId)
        .first();

      if (existingByJira) {
        // Update name/avatar, preserve existing values with COALESCE
        await env.DB
          .prepare(
            `UPDATE identity_mappings
             SET real_name = COALESCE(?, real_name),
                 avatar_url = COALESCE(avatar_url, ?),
                 is_active = 1, updated_at = ?
             WHERE jira_account_id = ?`,
          )
          .bind(
            user.displayName || null,
            user.avatarUrl || null,
            now,
            user.accountId,
          )
          .run();
        synced++;
        continue;
      }

      // Tier 2: Match by email (links Jira to existing Slack/GitHub identity)
      if (user.emailAddress) {
        const existingByEmail = await env.DB
          .prepare("SELECT id FROM identity_mappings WHERE email = ?")
          .bind(user.emailAddress)
          .first();

        if (existingByEmail) {
          await env.DB
            .prepare(
              `UPDATE identity_mappings
               SET jira_account_id = ?, real_name = COALESCE(?, real_name),
                   avatar_url = COALESCE(avatar_url, ?), is_active = 1, updated_at = ?
               WHERE email = ?`,
            )
            .bind(
              user.accountId,
              user.displayName || null,
              user.avatarUrl || null,
              now,
              user.emailAddress,
            )
            .run();
          synced++;
          continue;
        }
      }

      // Tier 3: Insert new identity
      await env.DB
        .prepare(
          `INSERT INTO identity_mappings
           (id, jira_account_id, email, real_name, display_name, avatar_url, is_bot, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
        )
        .bind(
          generateULID(),
          user.accountId,
          user.emailAddress || null,
          user.displayName || user.accountId,
          user.displayName || null,
          user.avatarUrl || null,
          now,
          now,
        )
        .run();
      synced++;
    } catch (err) {
      console.error(`Failed to sync Jira identity for ${user.accountId}:`, err);
      skipped++;
    }
  }

  return { synced, skipped };
}

// ---------------------------------------------------------------------------
// User discovery
// ---------------------------------------------------------------------------

async function discoverUsers(
  client: ReturnType<typeof createJiraClient>,
  projectsStr?: string,
): Promise<Map<string, AtlassianUser>> {
  const users = new Map<string, AtlassianUser>();

  // Search for recently updated issues to collect unique users
  const projects = projectsStr
    ? projectsStr.split(",").map((p) => p.trim()).filter(Boolean)
    : [];

  let jql = `updated >= "-30d"`;
  if (projects.length > 0) {
    jql += ` AND project IN (${projects.map((p) => `"${p}"`).join(",")})`;
  }
  jql += " ORDER BY updated DESC";

  let startAt = 0;
  const maxPages = 5;

  for (let page = 0; page < maxPages; page++) {
    const result = await client.searchIssues(jql, {
      startAt,
      maxResults: 50,
      expand: [], // No changelog needed for identity sync
    });

    for (const issue of result.issues) {
      const f = issue.fields;

      // Collect assignee
      if (f.assignee?.accountId) {
        addUser(users, f.assignee);
      }
      // Collect reporter
      if (f.reporter?.accountId) {
        addUser(users, f.reporter);
      }
      // Collect creator
      if (f.creator?.accountId) {
        addUser(users, f.creator);
      }
    }

    if (startAt + result.issues.length >= result.total) break;
    startAt += 50;

    // Rate limit
    await new Promise((r) => setTimeout(r, 300));
  }

  return users;
}

function addUser(
  users: Map<string, AtlassianUser>,
  atlassianUser: { accountId: string; displayName: string; emailAddress?: string },
): void {
  if (users.has(atlassianUser.accountId)) return;

  // Construct 48x48 avatar URL from Atlassian account ID
  const avatarUrl = `https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/initials/${encodeURIComponent(atlassianUser.displayName.slice(0, 2))}-0.png`;

  users.set(atlassianUser.accountId, {
    accountId: atlassianUser.accountId,
    displayName: atlassianUser.displayName,
    emailAddress: atlassianUser.emailAddress,
    avatarUrl,
  });
}
