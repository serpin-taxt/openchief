CREATE TABLE reports (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  report_type  TEXT NOT NULL,
  content      TEXT NOT NULL,
  event_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_reports_agent ON reports(agent_id, created_at DESC);
CREATE INDEX idx_reports_type ON reports(agent_id, report_type, created_at DESC);
CREATE INDEX idx_reports_latest ON reports(created_at DESC);
