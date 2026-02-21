import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";

/**
 * Normalize a GitHub webhook payload into OpenChiefEvents.
 * A single webhook may produce multiple events (e.g., a push with multiple commits).
 */
export function normalizeGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>
): OpenChiefEvent[] {
  const now = new Date().toISOString();

  switch (eventType) {
    case "pull_request":
      return [normalizePR(payload, now)];
    case "pull_request_review":
      return [normalizeReview(payload, now)];
    case "issues":
      return [normalizeIssue(payload, now)];
    case "issue_comment":
      return [normalizeIssueComment(payload, now)];
    case "pull_request_review_comment":
      return [normalizePRReviewComment(payload, now)];
    case "push":
      return [normalizePush(payload, now)];
    case "workflow_run":
      return [normalizeWorkflowRun(payload, now)];
    default:
      return [normalizeGeneric(eventType, payload, now)];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ageHours(createdAt: string): number {
  return Math.round((Date.now() - new Date(createdAt).getTime()) / 3_600_000);
}

// ---------------------------------------------------------------------------
// Pull Request
// ---------------------------------------------------------------------------

function normalizePR(
  payload: Record<string, unknown>,
  now: string
): OpenChiefEvent {
  const action = payload.action as string;
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;

  const additions = pr.additions ?? "?";
  const deletions = pr.deletions ?? "?";
  const changedFiles = pr.changed_files ?? "?";
  const createdAt = pr.created_at as string;
  const mergedAt = pr.merged_at as string | null;
  const closedAt = pr.closed_at as string | null;
  const age = createdAt ? ageHours(createdAt) : "?";
  const labels = ((pr.labels as Array<Record<string, unknown>>) || []).map(
    (l) => l.name as string
  );
  const requestedReviewers = (
    (pr.requested_reviewers as Array<Record<string, unknown>>) || []
  ).map((r) => r.login as string);

  const parts = [
    `PR #${pr.number} "${pr.title}" was ${action} by ${sender.login} in ${repo.full_name}`,
    `+${additions}/-${deletions} files=${changedFiles}`,
    `created=${createdAt}${mergedAt ? ` merged=${mergedAt}` : ""}${closedAt && !mergedAt ? ` closed=${closedAt}` : ""} age_hours=${age}`,
  ];
  if (labels.length > 0) parts.push(`labels=[${labels.join(",")}]`);
  if (requestedReviewers.length > 0)
    parts.push(`requested_reviewers=[${requestedReviewers.join(",")}]`);
  if (pr.draft) parts.push("draft=true");

  return {
    id: generateULID(),
    timestamp: (pr.updated_at as string) || now,
    ingestedAt: now,
    source: "github",
    eventType: `pr.${action}`,
    scope: {
      org: (repo.owner as Record<string, unknown>)?.login as string,
      project: repo.full_name as string,
      actor: sender.login as string,
    },
    payload,
    summary: parts.join(" | "),
    tags: pr.draft ? ["draft"] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Pull Request Review
// ---------------------------------------------------------------------------

function normalizeReview(
  payload: Record<string, unknown>,
  now: string
): OpenChiefEvent {
  const action = payload.action as string;
  const review = payload.review as Record<string, unknown>;
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;

  const state = review.state as string;
  const submittedAt = review.submitted_at as string;
  const prAuthor = (pr.user as Record<string, unknown>)?.login as string;
  const body = review.body as string | null;
  const bodyLength = body?.length || 0;
  const prCreatedAt = pr.created_at as string;
  const timeToReview =
    submittedAt && prCreatedAt
      ? Math.round(
          (new Date(submittedAt).getTime() -
            new Date(prCreatedAt).getTime()) /
            3_600_000
        )
      : null;

  const parts = [
    `REVIEW on PR #${pr.number} "${pr.title}" by ${sender.login}: ${state} in ${repo.full_name}`,
    `pr_author=${prAuthor}`,
    `submitted=${submittedAt}`,
    `time_to_review_hours=${timeToReview ?? "?"}`,
    `body_length=${bodyLength}`,
  ];

  return {
    id: generateULID(),
    timestamp: submittedAt || now,
    ingestedAt: now,
    source: "github",
    eventType: `review.${action}`,
    scope: {
      org: (repo.owner as Record<string, unknown>)?.login as string,
      project: repo.full_name as string,
      actor: sender.login as string,
    },
    payload,
    summary: parts.join(" | "),
  };
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

function normalizeIssue(
  payload: Record<string, unknown>,
  now: string
): OpenChiefEvent {
  const action = payload.action as string;
  const issue = payload.issue as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;

  const createdAt = issue.created_at as string;
  const age = createdAt ? ageHours(createdAt) : "?";
  const labels = ((issue.labels as Array<Record<string, unknown>>) || []).map(
    (l) => l.name as string
  );

  const parts = [
    `Issue #${issue.number} "${issue.title}" was ${action} by ${sender.login}`,
    `created=${createdAt} age_hours=${age}`,
  ];
  if (labels.length > 0) parts.push(`labels=[${labels.join(",")}]`);

  return {
    id: generateULID(),
    timestamp: (issue.updated_at as string) || now,
    ingestedAt: now,
    source: "github",
    eventType: `issue.${action}`,
    scope: {
      org: (repo.owner as Record<string, unknown>)?.login as string,
      project: repo.full_name as string,
      actor: sender.login as string,
    },
    payload,
    summary: parts.join(" | "),
  };
}

// ---------------------------------------------------------------------------
// Issue Comment (covers both issue and PR discussion comments)
// ---------------------------------------------------------------------------

function normalizeIssueComment(
  payload: Record<string, unknown>,
  now: string
): OpenChiefEvent {
  const action = payload.action as string;
  const comment = payload.comment as Record<string, unknown>;
  const issue = payload.issue as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;

  const body = comment.body as string;
  const bodyPreview = body?.slice(0, 200) || "";
  const wordCount = body?.split(/\s+/).filter(Boolean).length || 0;
  const createdAt = comment.created_at as string;
  const issueNumber = issue.number as number;

  // Determine if this is on a PR or an issue
  const isPR = !!issue.pull_request;
  const eventType = isPR ? "comment.pr_discussion" : "comment.discussion";
  const prefix = isPR ? "PR_COMMENT" : "ISSUE_COMMENT";

  const parts = [
    `${prefix} on #${issueNumber} by ${sender.login} in ${repo.full_name}`,
    `at=${createdAt}`,
    `preview="${bodyPreview.slice(0, 100)}"`,
    `words=${wordCount}`,
  ];

  return {
    id: generateULID(),
    timestamp: createdAt || now,
    ingestedAt: now,
    source: "github",
    eventType,
    scope: {
      org: (repo.owner as Record<string, unknown>)?.login as string,
      project: repo.full_name as string,
      actor: sender.login as string,
    },
    payload,
    summary: parts.join(" | "),
  };
}

// ---------------------------------------------------------------------------
// PR Review Comment (inline code comments)
// ---------------------------------------------------------------------------

function normalizePRReviewComment(
  payload: Record<string, unknown>,
  now: string
): OpenChiefEvent {
  const action = payload.action as string;
  const comment = payload.comment as Record<string, unknown>;
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;

  const body = comment.body as string;
  const bodyPreview = body?.slice(0, 200) || "";
  const wordCount = body?.split(/\s+/).filter(Boolean).length || 0;
  const createdAt = comment.created_at as string;
  const path = comment.path as string | null;
  const prNumber = pr.number as number;

  const parts = [
    `INLINE_REVIEW_COMMENT on PR #${prNumber} "${pr.title}" by ${sender.login} in ${repo.full_name}`,
    `file=${path || "unknown"}`,
    `at=${createdAt}`,
    `preview="${bodyPreview.slice(0, 100)}"`,
    `words=${wordCount}`,
  ];

  return {
    id: generateULID(),
    timestamp: createdAt || now,
    ingestedAt: now,
    source: "github",
    eventType: "comment.pr_review",
    scope: {
      org: (repo.owner as Record<string, unknown>)?.login as string,
      project: repo.full_name as string,
      actor: sender.login as string,
    },
    payload,
    summary: parts.join(" | "),
  };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

function normalizePush(
  payload: Record<string, unknown>,
  now: string
): OpenChiefEvent {
  const commits = payload.commits as Array<Record<string, unknown>>;
  const repo = payload.repository as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;
  const ref = payload.ref as string;
  const branch = ref.replace("refs/heads/", "");

  return {
    id: generateULID(),
    timestamp: now,
    ingestedAt: now,
    source: "github",
    eventType: "push.completed",
    scope: {
      org: (repo.owner as Record<string, unknown>)?.login as string,
      project: repo.full_name as string,
      actor: sender.login as string,
    },
    payload,
    summary: `${sender.login} pushed ${commits?.length || 0} commit(s) to ${branch} in ${repo.full_name}`,
  };
}

// ---------------------------------------------------------------------------
// Workflow Run (CI/CD builds)
// ---------------------------------------------------------------------------

function normalizeWorkflowRun(
  payload: Record<string, unknown>,
  now: string
): OpenChiefEvent {
  const action = payload.action as string;
  const run = payload.workflow_run as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown>;

  const conclusion = run.conclusion as string | null;
  const eventType =
    conclusion === "failure"
      ? "build.failed"
      : conclusion === "success"
        ? "build.succeeded"
        : `build.${action}`;
  const triggeringActor = (run.triggering_actor as Record<string, unknown>)
    ?.login as string;
  const headBranch = run.head_branch as string;

  const parts = [
    `Workflow "${run.name}" ${conclusion || action} in ${repo.full_name}`,
    `triggering_actor=${triggeringActor || sender.login}`,
    `branch=${headBranch}`,
  ];

  return {
    id: generateULID(),
    timestamp: (run.updated_at as string) || now,
    ingestedAt: now,
    source: "github",
    eventType,
    scope: {
      org: (repo.owner as Record<string, unknown>)?.login as string,
      project: repo.full_name as string,
      actor: sender.login as string,
    },
    payload,
    summary: parts.join(" | "),
    tags: conclusion === "failure" ? ["build-failure"] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Generic / unknown event type
// ---------------------------------------------------------------------------

function normalizeGeneric(
  eventType: string,
  payload: Record<string, unknown>,
  now: string
): OpenChiefEvent {
  const repo = payload.repository as Record<string, unknown> | undefined;
  const sender = payload.sender as Record<string, unknown> | undefined;

  return {
    id: generateULID(),
    timestamp: now,
    ingestedAt: now,
    source: "github",
    eventType: `github.${eventType}`,
    scope: {
      org: repo
        ? ((repo.owner as Record<string, unknown>)?.login as string)
        : undefined,
      project: repo?.full_name as string | undefined,
      actor: sender?.login as string | undefined,
    },
    payload,
    summary: `GitHub event: ${eventType}`,
  };
}
