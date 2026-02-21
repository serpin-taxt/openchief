import type { AgentDefinition } from "./agent.js";

export interface AgentRevision {
  /** Unique revision ID (ULID) */
  id: string;

  /** Which agent was changed */
  agentId: string;

  /** Full AgentDefinition snapshot at this point in time */
  config: AgentDefinition;

  /** Email of the person who made the change */
  changedBy: string;

  /** Short description of what changed */
  changeNote: string;

  /** When the revision was created */
  createdAt: string;
}
