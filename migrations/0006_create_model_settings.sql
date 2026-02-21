CREATE TABLE IF NOT EXISTS model_settings (
  job_type    TEXT PRIMARY KEY,
  model_id    TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  max_tokens  INTEGER NOT NULL DEFAULT 8192,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT
);

-- Seed default values
INSERT OR IGNORE INTO model_settings (job_type, model_id, max_tokens, updated_at) VALUES
  ('daily-report', 'claude-sonnet-4-6', 8192, datetime('now'));
INSERT OR IGNORE INTO model_settings (job_type, model_id, max_tokens, updated_at) VALUES
  ('weekly-report', 'claude-sonnet-4-6', 8192, datetime('now'));
INSERT OR IGNORE INTO model_settings (job_type, model_id, max_tokens, updated_at) VALUES
  ('meeting', 'claude-sonnet-4-6', 32768, datetime('now'));
INSERT OR IGNORE INTO model_settings (job_type, model_id, max_tokens, updated_at) VALUES
  ('chat', 'claude-sonnet-4-6', 8192, datetime('now'));
