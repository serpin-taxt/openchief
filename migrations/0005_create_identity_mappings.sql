-- Cross-platform identity mappings
-- Links usernames across GitHub, Slack, Figma, Discord, emails, and real names
CREATE TABLE identity_mappings (
  id               TEXT PRIMARY KEY,
  github_username  TEXT UNIQUE,
  slack_user_id    TEXT UNIQUE,
  email            TEXT UNIQUE,
  real_name        TEXT NOT NULL,
  display_name     TEXT,
  team             TEXT,
  role             TEXT,
  avatar_url       TEXT,
  figma_handle     TEXT,
  discord_handle   TEXT,
  is_bot           INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_identity_github ON identity_mappings(github_username);
CREATE INDEX idx_identity_slack ON identity_mappings(slack_user_id);
CREATE INDEX idx_identity_email ON identity_mappings(email);
CREATE INDEX idx_identity_figma ON identity_mappings(figma_handle);
CREATE INDEX idx_identity_discord ON identity_mappings(discord_handle);
