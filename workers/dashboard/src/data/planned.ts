/**
 * Planned modules and connections shown in the UI as coming-soon placeholders.
 * Remove entries from here as they become real (i.e., when an agent definition
 * is created in D1 or a connector worker is deployed).
 */

export interface PlannedModule {
  name: string;
  description: string;
}

export const PLANNED_MODULES: PlannedModule[] = [];

export interface PlannedConnection {
  label: string;
  icon: string;
}

export const PLANNED_CONNECTIONS: PlannedConnection[] = [
  { label: "Pilot", icon: "📊" },
  { label: "Confluence", icon: "📄" },
  { label: "Brex", icon: "💳" },
  { label: "Fly.io", icon: "🚀" },
  { label: "Google Cloud Platform", icon: "☁️" },
  { label: "Google Drive", icon: "📁" },
  { label: "Google Docs", icon: "📃" },
  { label: "Google Meetings", icon: "🎥" },
  { label: "Onchain Data", icon: "⛓️" },
  { label: "Linear", icon: "📐" },
  { label: "PagerDuty", icon: "🚨" },
  { label: "Datadog", icon: "🐕" },
  { label: "Stripe", icon: "💰" },
  { label: "HubSpot", icon: "🔶" },
  { label: "Zendesk", icon: "🎧" },
];
