CREATE TABLE agent_revisions (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agent_definitions(id),
  config       TEXT NOT NULL,
  changed_by   TEXT NOT NULL,
  change_note  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_revisions_agent ON agent_revisions(agent_id, created_at DESC);
