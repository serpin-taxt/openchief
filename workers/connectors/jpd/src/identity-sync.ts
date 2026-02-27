/**
 * Sync JPD (Jira Product Discovery) user profiles into the D1 identity_mappings table.
 *
 * Uses the same Atlassian account IDs as the Jira connector — identities
 * already linked by the Jira connector will be reused (no duplicates).
 *
 * Discovery: collects unique accountIds from assignee, reporter, and creator
 * fields on recently updated JPD ideas.
 */

import { generateULID } from "@openchief/shared";
import { createJpdClient } from "./jpd-api";

interface AtlassianUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

interface IdentitySyncEnv {
  JPD_API_EMAIL: string;
  JPD_API_TOKEN: string;
  JPD_INSTANCE_URL: string;
  JPD_PROJECTS?: string;
  DB: D1Database;
}

export async function syncJpdIdentities(
  env: IdentitySyncEnv,
): Promise<{ synced: number; skipped: number }> {
  const client = createJpdClient(
    env.JPD_INSTANCE_URL,
    env.JPD_API_EMAIL,
    env.JPD_API_TOKEN,
  );

  // 1. Discover unique users from recent ideas
  const users = await discoverUsers(client, env.JPD_PROJECTS);
  console.log(`JPD identity sync: ${users.size} unique users discovered`);

  // 2. Upsert into identity_mappings
  let synced = 0;
  let skipped = 0;

  for (const user of users.values()) {
    try {
      const now = new Date().toISOString();

      // Tier 1: Match by jira_account_id (shared Atlassian ID)
      const existingByJira = await env.DB
        .prepare("SELECT id FROM identity_mappings WHERE jira_account_id = ?")
        .bind(user.accountId)
        .first();

      if (existingByJira) {
        await env.DB
          .prepare(
            `UPDATE identity_mappings
             SET real_name = COALESCE(?, real_name),
                 is_active = 1, updated_at = ?
             WHERE jira_account_id = ?`,
          )
          .bind(user.displayName || null, now, user.accountId)
          .run();
        synced++;
        continue;
      }

      // Tier 2: Match by email
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
                   is_active = 1, updated_at = ?
               WHERE email = ?`,
            )
            .bind(
              user.accountId,
              user.displayName || null,
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
           (id, jira_account_id, email, real_name, display_name, is_bot, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`,
        )
        .bind(
          generateULID(),
          user.accountId,
          user.emailAddress || null,
          user.displayName || user.accountId,
          user.displayName || null,
          now,
          now,
        )
        .run();
      synced++;
    } catch (err) {
      console.error(`Failed to sync JPD identity for ${user.accountId}:`, err);
      skipped++;
    }
  }

  return { synced, skipped };
}

// ---------------------------------------------------------------------------
// User discovery
// ---------------------------------------------------------------------------

async function discoverUsers(
  client: ReturnType<typeof createJpdClient>,
  projectsStr?: string,
): Promise<Map<string, AtlassianUser>> {
  const users = new Map<string, AtlassianUser>();

  const projects = projectsStr
    ? projectsStr.split(",").map((p) => p.trim()).filter(Boolean)
    : [];

  let jql = `issuetype = Idea AND updated >= "-30d"`;
  if (projects.length > 0) {
    jql += ` AND project IN (${projects.map((p) => `"${p}"`).join(",")})`;
  }
  jql += " ORDER BY updated DESC";

  let startAt = 0;
  const maxPages = 5;

  for (let page = 0; page < maxPages; page++) {
    const result = await client.searchIdeas(jql, { startAt, maxResults: 50 });

    for (const idea of result.issues) {
      const f = idea.fields;

      if (f.assignee?.accountId) {
        addUser(users, f.assignee);
      }
      if (f.reporter?.accountId) {
        addUser(users, f.reporter);
      }
      if (f.creator?.accountId) {
        addUser(users, f.creator);
      }
    }

    if (startAt + result.issues.length >= result.total) break;
    startAt += 50;

    await new Promise((r) => setTimeout(r, 300));
  }

  return users;
}

function addUser(
  users: Map<string, AtlassianUser>,
  atlassianUser: { accountId: string; displayName: string; emailAddress?: string },
): void {
  if (users.has(atlassianUser.accountId)) return;
  users.set(atlassianUser.accountId, {
    accountId: atlassianUser.accountId,
    displayName: atlassianUser.displayName,
    emailAddress: atlassianUser.emailAddress,
  });
}
