CREATE TABLE agent_definitions (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  config       TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE agent_subscriptions (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agent_definitions(id),
  source          TEXT NOT NULL,
  event_types     TEXT NOT NULL,
  scope_filter    TEXT
);

CREATE INDEX idx_subscriptions_source ON agent_subscriptions(source);
CREATE INDEX idx_subscriptions_agent ON agent_subscriptions(agent_id);
