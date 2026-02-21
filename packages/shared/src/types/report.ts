export interface AgentReport {
  id: string;
  agentId: string;
  reportType: string;
  content: ReportContent;
  eventCount: number;
  createdAt: string;
}

export interface ReportContent {
  /** One-line summary of the entire report */
  headline: string;

  /** Structured sections matching the agent's report config */
  sections: ReportSection[];

  /** Items requiring immediate attention */
  actionItems: ActionItem[];

  /** Overall health signal */
  healthSignal: "green" | "yellow" | "red";
}

export interface ReportSection {
  /** Section name matching the config (e.g. "pr-review-status") */
  name: string;

  /** Markdown-formatted content */
  body: string;

  /** Severity for this section */
  severity: "info" | "warning" | "critical";
}

export interface ActionItem {
  description: string;
  priority: "low" | "medium" | "high" | "critical";

  /** Link back to the source (PR URL, issue URL, etc.) */
  sourceUrl?: string;

  /** Who this is relevant to */
  assignee?: string;
}
