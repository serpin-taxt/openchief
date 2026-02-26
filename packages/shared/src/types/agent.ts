export interface AgentDefinition {
  /** Unique agent identifier (e.g. "eng-manager") */
  id: string;

  /** Human-readable name (e.g. "Engineering Manager") */
  name: string;

  /** Short description of what this agent watches */
  description: string;

  /** Data subscriptions — the event router matches incoming events against these */
  subscriptions: EventSubscription[];

  /** The agent's persona and instructions for Claude */
  persona: AgentPersona;

  /** Output configuration — what reports this agent produces */
  outputs: AgentOutputConfig;

  /** Whether this agent is currently active */
  enabled: boolean;

  /**
   * Tools this agent has access to (data-driven).
   * e.g. ["query_github", "query_database", "query_events"]
   * If empty or undefined, agent has no tool access (report-only mode).
   */
  tools?: string[];

  /** Access visibility: "public" (default, all users) or "exec" (restricted to allowedEmails) */
  visibility?: "public" | "exec";

  /** Emails allowed to view this agent when visibility is "exec" */
  allowedEmails?: string[];

  /**
   * Company strategy context — used by the CEO agent to anchor every
   * meeting around long-term mission, vision, values, and goals.
   * Other agents can also reference this for strategic alignment.
   */
  strategy?: AgentStrategy;

  /** Slack channel ID to post daily reports to (e.g. "C1234567890") */
  slackChannelId?: string;

  /** Report schedule time in local timezone, HH:MM format (e.g. "08:00", "09:30"). Uses REPORT_TIMEZONE. */
  scheduleTime?: string;
}

export interface EventSubscription {
  /** Match events from this source (exact match) */
  source: string;

  /**
   * Match event types. Supports wildcards:
   * - "pr.*" matches pr.opened, pr.merged, etc.
   * - "*" matches everything from that source
   */
  eventTypes: string[];

  /** Optional scope filters (AND logic — all specified fields must match) */
  scopeFilter?: {
    org?: string;
    /** Single project or array of allowed projects (OR logic within the array) */
    project?: string | string[];
    team?: string;
  };
}

export interface AgentPersona {
  /** The role identity, injected at the top of the system prompt */
  role: string;

  /** Detailed instructions for analysis */
  instructions: string;

  /** Specific things to flag or escalate */
  watchPatterns: string[];

  /** Tone and style of output */
  outputStyle: string;

  /** How this agent speaks — vocabulary, cadence, verbal habits, catchphrases */
  voice?: string;

  /** Who this agent is — temperament, values, quirks, communication style */
  personality?: string;
}

export interface AgentOutputConfig {
  reports: ReportConfig[];
}

export interface ReportConfig {
  /** e.g. "daily-standup", "daily-metrics-brief", "daily-meeting" */
  reportType: string;

  /** Report generation cadence */
  cadence: "daily";

  /** Sections this report should contain */
  sections: string[];
}

export interface AgentStrategy {
  /** The company's reason for existing — why it matters */
  mission?: string;

  /** Where the company is headed — the future state being built */
  vision?: string;

  /** Core principles that guide decisions and trade-offs */
  values?: string[];

  /** Current strategic goals — what "winning" looks like right now */
  goals?: string[];
}
