import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";
import { getInstallationToken } from "./github-app-auth";

/**
 * GitHub API poller -- fetches recent activity via the REST API.
 *
 * This serves two purposes:
 *   1. Backfill historical data that occurred before webhooks were set up.
 *   2. Catch any webhook deliveries that were missed or failed.
 *
 * The poller runs on a cron schedule (every 6 hours) and can also be
 * triggered manually via HTTP POST /poll.
 *
 * It uses a KV-stored cursor ("poll:cursor:{repo}") to track the last
 * poll time so it only fetches new data on subsequent runs.
 */

interface PollEnv {
  EVENTS_QUEUE: Queue;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_REPOS: string; // comma-separated, e.g. "org/repo1,org/repo2"
  POLL_CURSOR: KVNamespace;
}

interface PollResult {
  repo: string;
  prs: number;
  reviews: number;
  comments: number;
  issues: number;
  pushes: number;
  workflows: number;
  total: number;
}

/**
 * Poll all configured repos and enqueue normalized events.
 */
export async function pollAllRepos(env: PollEnv): Promise<PollResult[]> {
  const repos = env.GITHUB_REPOS.split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const results: PollResult[] = [];

  for (const repo of repos) {
    const result = await pollRepo(repo, env);
    results.push(result);
  }

  return results;
}

async function pollRepo(repo: string, env: PollEnv): Promise<PollResult> {
  const cursorKey = `poll:cursor:${repo}`;
  const lastPoll = await env.POLL_CURSOR.get(cursorKey);

  // Default: look back 30 days on first run, then use last poll time
  const since =
    lastPoll ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  console.log(`Polling ${repo} since ${since}`);

  // Get a valid installation token (cached, auto-refreshes)
  const token = await getInstallationToken(env);

  const events: OpenChiefEvent[] = [];

  // Fetch PRs first (needed for review polling)
  const { events: prEvents, rawPRs } = await fetchPRsWithRaw(
    repo,
    since,
    token
  );
  events.push(...prEvents);

  // Fetch reviews (depends on PR data), issues, commits, comments, and workflows in parallel
  const [reviews, issues, commits, comments, workflows] = await Promise.all([
    fetchReviews(repo, rawPRs, token),
    fetchIssues(repo, since, token),
    fetchCommits(repo, since, token),
    fetchComments(repo, since, token),
    fetchWorkflowRuns(repo, since, token),
  ]);

  events.push(...reviews);
  events.push(...issues);
  events.push(...commits);
  events.push(...comments);
  events.push(...workflows);

  // Enqueue all events
  let queued = 0;
  for (const event of events) {
    const slimEvent = slimPayload(event);
    await env.EVENTS_QUEUE.send(slimEvent);
    queued++;
  }

  // Update cursor to now
  await env.POLL_CURSOR.put(cursorKey, now);

  console.log(
    `Polled ${repo}: ${queued} events enqueued (${prEvents.length} PRs, ${reviews.length} reviews, ${comments.length} comments, ${issues.length} issues, ${commits.length} commits, ${workflows.length} workflows)`
  );

  return {
    repo,
    prs: prEvents.length,
    reviews: reviews.length,
    comments: comments.length,
    issues: issues.length,
    pushes: commits.length,
    workflows: workflows.length,
    total: queued,
  };
}

// ---------------------------------------------------------------------------
// Payload slimming
// ---------------------------------------------------------------------------

/**
 * Slim down the payload to essential fields to stay under queue size limits.
 * Full payloads from the GitHub API can be 50-200KB per item.
 */
function slimPayload(event: OpenChiefEvent): OpenChiefEvent {
  const p = event.payload;
  const slim: Record<string, unknown> = {
    _polled: true,
  };

  // Preserve key identifiers from common event types
  if (p.number) slim.number = p.number;
  if (p.title) slim.title = p.title;
  if (p.state) slim.state = p.state;
  if (p.html_url) slim.html_url = p.html_url;
  if (p.merged) slim.merged = p.merged;
  if (p.draft) slim.draft = p.draft;
  if (p.labels) slim.labels = p.labels;
  if (p.sha) slim.sha = p.sha;
  if (p.message) slim.message = p.message;
  if (p.conclusion) slim.conclusion = p.conclusion;
  if (p.status) slim.status = p.status;
  if (p.name) slim.name = p.name;
  if (p.additions !== undefined) slim.additions = p.additions;
  if (p.deletions !== undefined) slim.deletions = p.deletions;
  if (p.changed_files !== undefined) slim.changed_files = p.changed_files;

  // Timestamps for lifecycle analysis
  if (p.created_at) slim.created_at = p.created_at;
  if (p.updated_at) slim.updated_at = p.updated_at;
  if (p.closed_at) slim.closed_at = p.closed_at;
  if (p.merged_at) slim.merged_at = p.merged_at;
  if (p.submitted_at) slim.submitted_at = p.submitted_at;

  // Review/comment data
  if (p.requested_reviewers) slim.requested_reviewers = p.requested_reviewers;
  if (p.review_state) slim.review_state = p.review_state;
  if (p.pr_number) slim.pr_number = p.pr_number;
  if (p.pr_author) slim.pr_author = p.pr_author;
  if (p.body_preview) slim.body_preview = p.body_preview;
  if (p.body_length !== undefined) slim.body_length = p.body_length;
  if (p.word_count !== undefined) slim.word_count = p.word_count;
  if (p.time_to_review_hours !== undefined)
    slim.time_to_review_hours = p.time_to_review_hours;
  if (p.is_reply !== undefined) slim.is_reply = p.is_reply;

  // Workflow data
  if (p.triggering_actor) slim.triggering_actor = p.triggering_actor;
  if (p.head_branch) slim.head_branch = p.head_branch;

  return { ...event, payload: slim };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function ageHours(createdAt: string): number {
  return Math.round((Date.now() - new Date(createdAt).getTime()) / 3_600_000);
}

function hoursBetween(a: string, b: string): number | null {
  if (!a || !b) return null;
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000
  );
}

// ---------------------------------------------------------------------------
// GitHub API Helpers
// ---------------------------------------------------------------------------

async function githubFetch(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "openchief-connector-github",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Paginate through all pages of a GitHub API endpoint.
 */
async function githubPaginate<T>(
  baseUrl: string,
  token: string,
  maxPages = 10
): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = baseUrl;
  let page = 0;

  while (url && page < maxPages) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "openchief-connector-github",
      },
    });
    if (!res.ok) break;

    const data = (await res.json()) as T[];
    all.push(...data);

    // Parse Link header for next page
    const link = res.headers.get("link");
    const nextMatch = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    page++;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Fetch + Normalize Functions
// ---------------------------------------------------------------------------

/**
 * Fetch PRs and return both normalized events AND raw PR objects
 * (raw objects are needed by fetchReviews).
 */
async function fetchPRsWithRaw(
  repo: string,
  since: string,
  token: string
): Promise<{
  events: OpenChiefEvent[];
  rawPRs: Array<Record<string, unknown>>;
}> {
  const [owner] = repo.split("/");
  const url = `https://api.github.com/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
  const prs = await githubPaginate<Record<string, unknown>>(url, token, 5);
  const now = new Date().toISOString();

  const filtered = prs.filter((pr) => (pr.updated_at as string) >= since);

  const events = filtered.map((pr) => {
    const user = pr.user as Record<string, unknown>;
    const state = pr.merged_at ? "merged" : (pr.state as string);
    const createdAt = pr.created_at as string;
    const mergedAt = pr.merged_at as string | null;
    const closedAt = pr.closed_at as string | null;
    const additions = pr.additions ?? "?";
    const deletions = pr.deletions ?? "?";
    const changedFiles = pr.changed_files ?? "?";
    const labels = ((pr.labels as Array<Record<string, unknown>>) || []).map(
      (l) => l.name as string
    );
    const requestedReviewers = (
      (pr.requested_reviewers as Array<Record<string, unknown>>) || []
    ).map((r) => r.login as string);
    const age = createdAt ? ageHours(createdAt) : "?";

    // Build enriched summary
    const parts = [
      `PR #${pr.number} "${pr.title}" ${state} by ${user?.login} in ${repo}`,
      `+${additions}/-${deletions} files=${changedFiles}`,
      `created=${createdAt}${mergedAt ? ` merged=${mergedAt}` : ""}${closedAt && !mergedAt ? ` closed=${closedAt}` : ""} age_hours=${age}`,
    ];
    if (labels.length > 0) parts.push(`labels=[${labels.join(",")}]`);
    if (requestedReviewers.length > 0)
      parts.push(`requested_reviewers=[${requestedReviewers.join(",")}]`);
    if (pr.draft) parts.push("draft=true");

    return {
      id: generateULID(),
      timestamp: pr.updated_at as string,
      ingestedAt: now,
      source: "github",
      eventType: `pr.${state}`,
      scope: {
        org: owner,
        project: repo,
        actor: user?.login as string,
      },
      payload: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        merged: !!pr.merged_at,
        draft: pr.draft,
        html_url: pr.html_url,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        labels,
        requested_reviewers: requestedReviewers,
        created_at: createdAt,
        updated_at: pr.updated_at,
        closed_at: closedAt,
        merged_at: mergedAt,
      },
      summary: parts.join(" | "),
      tags: pr.draft ? ["draft"] : undefined,
    };
  });

  return { events, rawPRs: filtered };
}

/**
 * Fetch PR reviews for recently active PRs.
 * Gives us: who reviewed, review state, time-to-review, comment depth.
 */
async function fetchReviews(
  repo: string,
  recentPRs: Array<Record<string, unknown>>,
  token: string
): Promise<OpenChiefEvent[]> {
  const [owner] = repo.split("/");
  const now = new Date().toISOString();
  const events: OpenChiefEvent[] = [];

  // Only fetch reviews for up to 20 most recently updated PRs to control API usage
  const prsToCheck = recentPRs.slice(0, 20);

  for (const pr of prsToCheck) {
    const prNumber = pr.number as number;
    const prTitle = pr.title as string;
    const prAuthor = (pr.user as Record<string, unknown>)?.login as string;
    const prCreatedAt = pr.created_at as string;

    try {
      const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`;
      const reviews = await githubPaginate<Record<string, unknown>>(
        url,
        token,
        2
      );

      for (const review of reviews) {
        const reviewer = review.user as Record<string, unknown>;
        const state = review.state as string;
        const submittedAt = review.submitted_at as string;
        const body = review.body as string | null;
        const bodyLength = body?.length || 0;
        const timeToReview = hoursBetween(prCreatedAt, submittedAt);

        const parts = [
          `REVIEW on PR #${prNumber} "${prTitle}" by ${reviewer?.login}: ${state} in ${repo}`,
          `pr_author=${prAuthor}`,
          `submitted=${submittedAt}`,
          `time_to_review_hours=${timeToReview ?? "?"}`,
          `body_length=${bodyLength}`,
        ];

        events.push({
          id: generateULID(),
          timestamp: submittedAt || now,
          ingestedAt: now,
          source: "github",
          eventType: `review.${state.toLowerCase()}`,
          scope: {
            org: owner,
            project: repo,
            actor: reviewer?.login as string,
          },
          payload: {
            pr_number: prNumber,
            pr_title: prTitle,
            pr_author: prAuthor,
            review_state: state,
            body_length: bodyLength,
            submitted_at: submittedAt,
            time_to_review_hours: timeToReview,
            html_url: review.html_url,
          },
          summary: parts.join(" | "),
        });
      }
    } catch (err) {
      console.error(`Failed to fetch reviews for PR #${prNumber}: ${err}`);
    }
  }

  return events;
}

/**
 * Fetch PR review comments (inline code comments) and issue/PR discussion comments.
 * Gives us: comment tone, helpfulness, engagement patterns.
 */
async function fetchComments(
  repo: string,
  since: string,
  token: string
): Promise<OpenChiefEvent[]> {
  const [owner] = repo.split("/");
  const now = new Date().toISOString();
  const events: OpenChiefEvent[] = [];

  // 1. Inline PR review comments (comments on code diffs)
  try {
    const reviewCommentsUrl = `https://api.github.com/repos/${repo}/pulls/comments?sort=updated&direction=desc&since=${since}&per_page=100`;
    const reviewComments = await githubPaginate<Record<string, unknown>>(
      reviewCommentsUrl,
      token,
      3
    );

    for (const comment of reviewComments) {
      const user = comment.user as Record<string, unknown>;
      const body = comment.body as string;
      const bodyPreview = body?.slice(0, 200) || "";
      const wordCount = body?.split(/\s+/).filter(Boolean).length || 0;
      const createdAt = comment.created_at as string;
      const prUrl = comment.pull_request_url as string;
      const prNumber = prUrl
        ? parseInt(prUrl.split("/").pop() || "0")
        : 0;
      const isReply = !!comment.in_reply_to_id;

      events.push({
        id: generateULID(),
        timestamp: createdAt,
        ingestedAt: now,
        source: "github",
        eventType: "comment.pr_review",
        scope: {
          org: owner,
          project: repo,
          actor: user?.login as string,
        },
        payload: {
          pr_number: prNumber,
          body_preview: bodyPreview,
          word_count: wordCount,
          html_url: comment.html_url,
          is_reply: isReply,
          created_at: createdAt,
        },
        summary: `CODE_COMMENT on PR #${prNumber} by ${user?.login} in ${repo} | at=${createdAt} | preview="${bodyPreview.slice(0, 100)}" | words=${wordCount} | is_reply=${isReply}`,
      });
    }
  } catch (err) {
    console.error(`Failed to fetch PR review comments: ${err}`);
  }

  // 2. Issue/PR discussion comments (general conversation)
  try {
    const issueCommentsUrl = `https://api.github.com/repos/${repo}/issues/comments?sort=updated&direction=desc&since=${since}&per_page=100`;
    const issueComments = await githubPaginate<Record<string, unknown>>(
      issueCommentsUrl,
      token,
      3
    );

    for (const comment of issueComments) {
      const user = comment.user as Record<string, unknown>;
      const body = comment.body as string;
      const bodyPreview = body?.slice(0, 200) || "";
      const wordCount = body?.split(/\s+/).filter(Boolean).length || 0;
      const createdAt = comment.created_at as string;
      const issueUrl = comment.issue_url as string;
      const issueNumber = issueUrl
        ? parseInt(issueUrl.split("/").pop() || "0")
        : 0;

      events.push({
        id: generateULID(),
        timestamp: createdAt,
        ingestedAt: now,
        source: "github",
        eventType: "comment.discussion",
        scope: {
          org: owner,
          project: repo,
          actor: user?.login as string,
        },
        payload: {
          issue_number: issueNumber,
          body_preview: bodyPreview,
          word_count: wordCount,
          html_url: comment.html_url,
          created_at: createdAt,
        },
        summary: `DISCUSSION on #${issueNumber} by ${user?.login} in ${repo} | at=${createdAt} | preview="${bodyPreview.slice(0, 100)}" | words=${wordCount}`,
      });
    }
  } catch (err) {
    console.error(`Failed to fetch issue comments: ${err}`);
  }

  return events;
}

async function fetchIssues(
  repo: string,
  since: string,
  token: string
): Promise<OpenChiefEvent[]> {
  const [owner] = repo.split("/");
  const url = `https://api.github.com/repos/${repo}/issues?state=all&sort=updated&direction=desc&since=${since}&per_page=100`;
  const items = await githubPaginate<Record<string, unknown>>(url, token, 5);
  const now = new Date().toISOString();

  return items
    .filter((item) => !item.pull_request) // Exclude PRs from the issues endpoint
    .map((issue) => {
      const user = issue.user as Record<string, unknown>;
      const createdAt = issue.created_at as string;
      const labels = (
        (issue.labels as Array<Record<string, unknown>>) || []
      ).map((l) => l.name as string);
      const age = createdAt ? ageHours(createdAt) : "?";

      const parts = [
        `Issue #${issue.number} "${issue.title}" ${issue.state} by ${user?.login} in ${repo}`,
        `created=${createdAt} age_hours=${age}`,
      ];
      if (labels.length > 0) parts.push(`labels=[${labels.join(",")}]`);

      return {
        id: generateULID(),
        timestamp: issue.updated_at as string,
        ingestedAt: now,
        source: "github",
        eventType: `issue.${issue.state as string}`,
        scope: {
          org: owner,
          project: repo,
          actor: user?.login as string,
        },
        payload: {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          html_url: issue.html_url,
          labels,
          created_at: createdAt,
          updated_at: issue.updated_at,
          closed_at: issue.closed_at,
        },
        summary: parts.join(" | "),
      };
    });
}

async function fetchCommits(
  repo: string,
  since: string,
  token: string
): Promise<OpenChiefEvent[]> {
  const [owner] = repo.split("/");
  const url = `https://api.github.com/repos/${repo}/commits?since=${since}&per_page=100`;
  const commits = await githubPaginate<Record<string, unknown>>(
    url,
    token,
    5
  );
  const now = new Date().toISOString();

  return commits.map((commit) => {
    const commitData = commit.commit as Record<string, unknown>;
    const author = commit.author as Record<string, unknown> | null;
    const commitAuthor = commitData.author as Record<string, unknown>;
    const login =
      (author?.login as string) ||
      (commitAuthor?.name as string) ||
      "unknown";
    const message = (commitData.message as string)?.split("\n")[0];

    return {
      id: generateULID(),
      timestamp: (commitAuthor?.date as string) || now,
      ingestedAt: now,
      source: "github",
      eventType: "push.commit",
      scope: {
        org: owner,
        project: repo,
        actor: login,
      },
      payload: {
        sha: commit.sha,
        message,
        html_url: commit.html_url,
      },
      summary: `${login} committed "${message}" in ${repo}`,
    };
  });
}

async function fetchWorkflowRuns(
  repo: string,
  since: string,
  token: string
): Promise<OpenChiefEvent[]> {
  const [owner] = repo.split("/");
  const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=100`;
  const data = (await githubFetch(url, token)) as {
    workflow_runs: Array<Record<string, unknown>>;
  };
  const runs = data.workflow_runs || [];
  const now = new Date().toISOString();

  return runs
    .filter((run) => (run.updated_at as string) >= since)
    .filter((run) => run.status === "completed")
    .map((run) => {
      const conclusion = run.conclusion as string;
      const eventType =
        conclusion === "failure"
          ? "build.failed"
          : conclusion === "success"
            ? "build.succeeded"
            : `build.${conclusion}`;
      const actor = (run.actor as Record<string, unknown>)?.login as string;
      const triggeringActor = (
        run.triggering_actor as Record<string, unknown>
      )?.login as string;
      const headBranch = run.head_branch as string;

      const parts = [
        `Workflow "${run.name}" ${conclusion} in ${repo}`,
        `triggering_actor=${triggeringActor || actor}`,
        `branch=${headBranch}`,
      ];

      return {
        id: generateULID(),
        timestamp: run.updated_at as string,
        ingestedAt: now,
        source: "github",
        eventType,
        scope: {
          org: owner,
          project: repo,
          actor,
        },
        payload: {
          name: run.name,
          conclusion,
          status: run.status,
          html_url: run.html_url,
          triggering_actor: triggeringActor || actor,
          head_branch: headBranch,
        },
        summary: parts.join(" | "),
        tags: conclusion === "failure" ? ["build-failure"] : undefined,
      };
    });
}
