export interface OpenChiefEvent {
  /** Globally unique event ID (ULID for sortability) */
  id: string;

  /** ISO-8601 timestamp of when the event occurred at the source */
  timestamp: string;

  /** ISO-8601 timestamp of when we ingested it */
  ingestedAt: string;

  /** Source system identifier (e.g. "github", "slack", "discord") */
  source: string;

  /**
   * The type of event within that source.
   * Convention: <entity>.<action> using dot notation.
   * Examples: "pr.opened", "pr.merged", "message.posted", "payment.succeeded"
   */
  eventType: string;

  /** Scoping metadata for routing to agents */
  scope: EventScope;

  /** Raw payload from the source, preserved as-is */
  payload: Record<string, unknown>;

  /** Human-readable summary (1-3 sentences) */
  summary: string;

  /** Optional cross-cutting tags (e.g. ["urgent", "security"]) */
  tags?: string[];
}

export interface EventScope {
  /** Organization or workspace (e.g. GitHub org, Slack workspace) */
  org?: string;
  /** Project, repo, or channel name */
  project?: string;
  /** Team identifier */
  team?: string;
  /** User who triggered the event */
  actor?: string;
}
