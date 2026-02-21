import type { OpenChiefEvent, EventSubscription } from "../types/index.js";

/**
 * Check if an event matches a subscription's event type pattern.
 * Supports:
 *   - "*" matches everything
 *   - "pr.*" matches "pr.opened", "pr.merged", etc.
 *   - "build.failed" matches exactly
 */
function matchesEventType(eventType: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(prefix + ".");
  }
  return eventType === pattern;
}

/**
 * Check if an event matches a subscription (source + event types + optional scope filter).
 */
export function matchesSubscription(
  event: OpenChiefEvent,
  sub: EventSubscription
): boolean {
  // Source must match exactly
  if (event.source !== sub.source) return false;

  // At least one event type pattern must match
  const typeMatch = sub.eventTypes.some((pattern) =>
    matchesEventType(event.eventType, pattern)
  );
  if (!typeMatch) return false;

  // If scope filter is specified, all provided fields must match
  if (sub.scopeFilter) {
    if (sub.scopeFilter.org && event.scope.org !== sub.scopeFilter.org)
      return false;
    if (
      sub.scopeFilter.project &&
      event.scope.project !== sub.scopeFilter.project
    )
      return false;
    if (sub.scopeFilter.team && event.scope.team !== sub.scopeFilter.team)
      return false;
  }

  return true;
}

/**
 * Find all agent IDs that should receive a given event,
 * based on a list of subscriptions keyed by agent ID.
 */
export function findMatchingAgents(
  event: OpenChiefEvent,
  subscriptionsByAgent: Map<string, EventSubscription[]>
): string[] {
  const matchingAgents: string[] = [];

  for (const [agentId, subs] of subscriptionsByAgent) {
    if (subs.some((sub) => matchesSubscription(event, sub))) {
      matchingAgents.push(agentId);
    }
  }

  return matchingAgents;
}
