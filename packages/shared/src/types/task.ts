/**
 * Task system types — agents propose tasks, CEO prioritizes, agents execute.
 */

export type TaskStatus =
  | "proposed"
  | "queued"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number; // 0-100
  createdBy: string; // agent_id
  assignedTo: string | null; // agent_id
  sourceReportId: string | null;
  output: TaskOutput | null;
  context: TaskContext | null;
  startedAt: string | null;
  completedAt: string | null;
  dueBy: string | null;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskOutput {
  summary: string; // One-line result summary
  content: string; // Full markdown output
  artifacts: TaskArtifact[];
}

export interface TaskArtifact {
  name: string; // e.g., "blog-draft-v1"
  type: string; // e.g., "markdown", "json"
  content: string;
}

export interface TaskContext {
  reasoning: string; // Why this task was created
  relevantUrls?: string[];
}

/**
 * What Claude outputs when proposing tasks during report generation.
 * Priority is a human-readable level that gets mapped to 0-100.
 */
export interface TaskProposal {
  title: string;
  description: string;
  assignTo: string; // suggested agent_id
  context: TaskContext;
  priority: "low" | "medium" | "high" | "critical";
}

/**
 * What the CEO outputs when prioritizing tasks during the meeting.
 */
export interface TaskDecision {
  taskId: string;
  action: "queue" | "cancel";
  priority: number; // 0-100
  notes?: string;
}
