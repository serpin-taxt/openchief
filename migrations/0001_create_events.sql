CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  timestamp     TEXT NOT NULL,
  ingested_at   TEXT NOT NULL,
  source        TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  scope_org     TEXT,
  scope_project TEXT,
  scope_team    TEXT,
  scope_actor   TEXT,
  summary       TEXT NOT NULL,
  payload       TEXT NOT NULL,
  tags          TEXT
);

CREATE INDEX idx_events_source ON events(source);
CREATE INDEX idx_events_type ON events(source, event_type);
CREATE INDEX idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX idx_events_project ON events(scope_project);
