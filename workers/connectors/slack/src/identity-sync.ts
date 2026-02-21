/**
 * Sync Slack user profiles into the D1 identity_mappings table.
 * Matches by email when possible to link Slack IDs to existing GitHub identities.
 */

import { generateULID } from "@openchief/shared";
import type { SlackUser } from "./slack-api";
import { slackUserToInfo } from "./user-cache";

export async function syncIdentities(
  users: SlackUser[],
  db: D1Database
): Promise<{ upserted: number; skipped: number }> {
  let upserted = 0;
  let skipped = 0;

  for (const user of users) {
    // Skip deactivated users
    if (user.deleted) {
      skipped++;
      continue;
    }

    const info = slackUserToInfo(user);
    const now = new Date().toISOString();

    try {
      // First, check if this Slack user ID already exists
      const existingBySlack = await db
        .prepare(
          "SELECT id FROM identity_mappings WHERE slack_user_id = ?"
        )
        .bind(user.id)
        .first();

      if (existingBySlack) {
        // Update existing row
        await db
          .prepare(
            `UPDATE identity_mappings
             SET real_name = ?, display_name = ?, avatar_url = ?,
                 is_bot = ?, is_active = 1, updated_at = ?
             ${info.email ? ", email = ?" : ""}
             WHERE slack_user_id = ?`
          )
          .bind(
            ...[
              info.realName,
              info.displayName,
              info.avatarUrl || null,
              info.isBot ? 1 : 0,
              now,
              ...(info.email ? [info.email] : []),
              user.id,
            ]
          )
          .run();
        upserted++;
        continue;
      }

      // Check if we can match by email (links to existing GitHub identity)
      if (info.email) {
        const existingByEmail = await db
          .prepare(
            "SELECT id FROM identity_mappings WHERE email = ?"
          )
          .bind(info.email)
          .first();

        if (existingByEmail) {
          // Link Slack ID to existing row
          await db
            .prepare(
              `UPDATE identity_mappings
               SET slack_user_id = ?, real_name = ?, display_name = ?,
                   avatar_url = ?, is_bot = ?, is_active = 1, updated_at = ?
               WHERE email = ?`
            )
            .bind(
              user.id,
              info.realName,
              info.displayName,
              info.avatarUrl || null,
              info.isBot ? 1 : 0,
              now,
              info.email
            )
            .run();
          upserted++;
          continue;
        }
      }

      // Insert new identity
      await db
        .prepare(
          `INSERT INTO identity_mappings
           (id, slack_user_id, email, real_name, display_name, avatar_url, is_bot, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(
          generateULID(),
          user.id,
          info.email || null,
          info.realName,
          info.displayName,
          info.avatarUrl || null,
          info.isBot ? 1 : 0,
          now,
          now
        )
        .run();
      upserted++;
    } catch (err) {
      console.error(`Failed to sync identity for ${user.id}:`, err);
      skipped++;
    }
  }

  return { upserted, skipped };
}
