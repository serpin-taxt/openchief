-- Tasks: agent-proposed work items with CEO prioritization and autonomous execution
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'proposed',  -- proposed | queued | in_progress | completed | cancelled
  priority        INTEGER NOT NULL DEFAULT 50,       -- 0-100, higher = more important (CEO sets this)
  created_by      TEXT NOT NULL,                     -- agent_id that proposed the task
  assigned_to     TEXT,                              -- agent_id assigned to execute
  source_report_id TEXT,                             -- report ID that spawned this task
  output          TEXT,                              -- JSON: { summary, content, artifacts[] }
  context         TEXT,                              -- JSON: { reasoning, relevantUrls? }
  started_at      TEXT,                              -- ISO-8601 when execution began
  completed_at    TEXT,                              -- ISO-8601 when execution finished
  due_by          TEXT,                              -- ISO-8601 optional deadline
  tokens_used     INTEGER DEFAULT 0,                 -- total tokens consumed during execution
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);

-- Add task-execution as a configurable model setting
INSERT OR IGNORE INTO model_settings (job_type, model_id, max_tokens, updated_at)
  VALUES ('task-execution', 'claude-sonnet-4-6', 16384, datetime('now'));
