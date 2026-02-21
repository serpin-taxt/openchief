/**
 * Event generators -- one function per source, each returns a batch of
 * realistic OpenChiefEvents spread over the last ~30 minutes.
 */

import type { OpenChiefEvent } from "@openchief/shared";
import { generateULID } from "@openchief/shared";
import {
  TEAM, ORG, REPO, SLACK_WORKSPACE, DISCORD_SERVER, JIRA_PROJECT,
  SLACK_CHANNELS, DISCORD_CHANNELS, PR_TITLES, JIRA_TICKETS,
  COMMUNITY_MEMBERS, CUSTOMERS,
  pick, pickN, randInt, randFloat, recentTimestamp,
  type TeamMember,
} from "./world";

const now = (): string => new Date().toISOString();

// -- GitHub events --------------------------------------------------------------

export function generateGitHubEvents(): OpenChiefEvent[] {
  const events: OpenChiefEvent[] = [];
  const engineers = TEAM.filter(m => m.team === "engineering" || m.github === "ninapatel");

  // 2-4 PR events per cycle
  const prCount = randInt(2, 4);
  for (let i = 0; i < prCount; i++) {
    const author = pick(engineers);
    const prNum = randInt(200, 500);
    const title = pick(PR_TITLES);
    const action = pick(["opened", "merged", "closed", "synchronize"] as const);
    const additions = randInt(5, 300);
    const deletions = randInt(1, 100);
    const files = randInt(1, 20);
    const reviewers = pickN(engineers.filter(e => e.github !== author.github), randInt(1, 3));
    const labels = pickN(["feature", "bug", "refactor", "security", "performance", "docs", "breaking"], randInt(0, 3));
    const ts = recentTimestamp(1, 25);

    events.push({
      id: generateULID(),
      timestamp: ts,
      ingestedAt: now(),
      source: "github",
      eventType: action === "merged" ? "pr.merged" : action === "synchronize" ? "pr.synchronize" : `pr.${action}`,
      scope: { org: ORG, project: REPO, actor: author.name },
      payload: {
        number: prNum,
        title,
        action,
        additions,
        deletions,
        changed_files: files,
        labels,
        draft: false,
        requested_reviewers: reviewers.map(r => r.github),
        author: author.github,
        url: `https://github.com/${REPO}/pull/${prNum}`,
      },
      summary: `PR #${prNum} "${title}" was ${action} by ${author.name} in ${REPO} | +${additions}/-${deletions} files=${files}${labels.length ? ` | labels=[${labels.join(",")}]` : ""}`,
      tags: labels.includes("security") ? ["security"] : undefined,
    });
  }

  // 1-3 reviews
  const reviewCount = randInt(1, 3);
  for (let i = 0; i < reviewCount; i++) {
    const reviewer = pick(engineers);
    const prNum = randInt(200, 500);
    const state = pick(["approved", "changes_requested", "commented"] as const);
    const ts = recentTimestamp(1, 25);

    events.push({
      id: generateULID(),
      timestamp: ts,
      ingestedAt: now(),
      source: "github",
      eventType: `review.submitted`,
      scope: { org: ORG, project: REPO, actor: reviewer.name },
      payload: {
        pr_number: prNum,
        state,
        reviewer: reviewer.github,
        time_to_review_hours: randFloat(0.5, 24),
      },
      summary: `${reviewer.name} ${state.replace("_", " ")} PR #${prNum} in ${REPO}`,
    });
  }

  // 0-1 build events
  if (Math.random() > 0.4) {
    const branch = pick(["main", "feature/auth-v2", "fix/memory-leak", "feature/permissions"]);
    const conclusion = Math.random() > 0.15 ? "success" : "failure";
    const triggerer = pick(engineers);
    const ts = recentTimestamp(1, 20);

    events.push({
      id: generateULID(),
      timestamp: ts,
      ingestedAt: now(),
      source: "github",
      eventType: conclusion === "success" ? "build.succeeded" : "build.failed",
      scope: { org: ORG, project: REPO, actor: triggerer.name },
      payload: {
        workflow: "CI / Build & Test",
        branch,
        conclusion,
        triggering_actor: triggerer.github,
        duration_seconds: randInt(60, 600),
      },
      summary: `Build ${conclusion} on ${branch} in ${REPO} (triggered by ${triggerer.name})`,
      tags: conclusion === "failure" ? ["build-failure"] : undefined,
    });
  }

  return events;
}

// -- Slack events ---------------------------------------------------------------

export function generateSlackEvents(): OpenChiefEvent[] {
  const events: OpenChiefEvent[] = [];
  const messageCount = randInt(8, 20);

  const slackMessages = [
    "Deployed v2.4.1 to staging -- looks good so far",
    "Can someone review my PR? It's been open since yesterday",
    "The auth service is throwing 500s again, investigating",
    "Customer demo went well! They're interested in the enterprise plan",
    "Sprint retro at 3pm today, don't forget",
    "Fixed the memory leak -- it was a closure holding a reference to the entire request object",
    "New design mockups are in Figma, feedback welcome",
    "Heads up: deploying database migration at 2pm UTC",
    "The new onboarding flow increased activation by 12%",
    "Anyone else seeing high latency on the search endpoint?",
    "Quick standup update: auth migration is 80% done, should land tomorrow",
    "Merged the rate limiting PR -- please test when you get a chance",
    "Support ticket volume is up 15% this week, mostly billing questions",
    "Reminder: security review for the file upload feature is Thursday",
    "Good news: page load time dropped 40% after the CDN changes",
    "Can we schedule a design review for the settings page?",
    "FYI: the staging DB will be down for 10 min at 4pm for maintenance",
    "The A/B test results are in -- variant B wins by 8%",
    "Just shipped dark mode to 10% of users, monitoring for issues",
    "Customer feedback: they love the new API docs",
    "Build is green again, the flaky test was fixed",
    "Working on the billing refactor today, might need help with the Stripe webhook handler",
    "Promoted the new hire's PR -- great first contribution!",
    "Quarterly planning doc is ready for review in Notion",
    "The caching layer is saving us ~$200/day in API costs",
  ];

  for (let i = 0; i < messageCount; i++) {
    const member = pick(TEAM);
    const channel = pick(SLACK_CHANNELS);
    const isThread = Math.random() > 0.7;
    const text = pick(slackMessages);
    const ts = recentTimestamp(1, 28);

    events.push({
      id: generateULID(),
      timestamp: ts,
      ingestedAt: now(),
      source: "slack",
      eventType: isThread ? "thread.replied" : "message.posted",
      scope: { org: SLACK_WORKSPACE, project: channel, actor: member.name },
      payload: {
        channel_name: channel.replace("#", ""),
        user_name: member.slack,
        text,
        is_thread: isThread,
      },
      summary: `${member.name} ${isThread ? "replied" : ""} in ${channel}: ${text}`,
    });
  }

  // 1-2 reactions
  for (let i = 0; i < randInt(1, 2); i++) {
    const member = pick(TEAM);
    const channel = pick(SLACK_CHANNELS);
    const emoji = pick(["+1", "eyes", "rocket", "fire", "thinking_face", "white_check_mark", "tada"]);
    const ts = recentTimestamp(1, 28);

    events.push({
      id: generateULID(),
      timestamp: ts,
      ingestedAt: now(),
      source: "slack",
      eventType: "reaction.added",
      scope: { org: SLACK_WORKSPACE, project: channel, actor: member.name },
      payload: { emoji, channel_name: channel.replace("#", "") },
      summary: `${member.name} reacted with :${emoji}: in ${channel}`,
    });
  }

  return events;
}

// -- Discord events -------------------------------------------------------------

export function generateDiscordEvents(): OpenChiefEvent[] {
  const events: OpenChiefEvent[] = [];
  const messageCount = randInt(3, 8);

  const communityMessages = [
    "Hey, loving the new API! Just integrated it into my side project",
    "Is there a way to increase the rate limit for the free tier?",
    "Found a bug: the /users endpoint returns 404 when using API keys",
    "Feature request: could you add webhook support for project events?",
    "Just published a blog post about building with your platform!",
    "The docs for the auth flow are a bit confusing, could use some examples",
    "Thanks for fixing the pagination issue so quickly!",
    "Any plans to support GraphQL?",
    "The SDK is much better since the v2 update, great work team!",
    "Running into CORS issues when calling from localhost, any tips?",
    "Would love to see a Python SDK in addition to the Node one",
    "The community Discord is awesome, learned so much here",
  ];

  for (let i = 0; i < messageCount; i++) {
    const isTeam = Math.random() > 0.6;
    const actor = isTeam ? pick(TEAM).name : pick(COMMUNITY_MEMBERS);
    const channel = pick(DISCORD_CHANNELS);
    const text = pick(communityMessages);
    const isThread = Math.random() > 0.7;
    const ts = recentTimestamp(1, 28);

    events.push({
      id: generateULID(),
      timestamp: ts,
      ingestedAt: now(),
      source: "discord",
      eventType: isThread ? "thread.replied" : "message.posted",
      scope: { org: DISCORD_SERVER, project: channel, actor },
      payload: {
        channel_name: channel,
        author: actor,
        content: text,
        is_reply: isThread,
      },
      summary: `${actor} ${isThread ? "replied " : ""}in #${channel}: ${text}`,
    });
  }

  return events;
}

// -- Jira events ----------------------------------------------------------------

export function generateJiraEvents(): OpenChiefEvent[] {
  const events: OpenChiefEvent[] = [];
  const count = randInt(2, 5);

  const transitions = ["To Do -> In Progress", "In Progress -> In Review", "In Review -> Done", "Done -> Deployed"];
  const productPeople = TEAM.filter(m => ["product", "engineering"].includes(m.team));

  for (let i = 0; i < count; i++) {
    const ticket = pick(JIRA_TICKETS);
    const actor = pick(productPeople);
    const isTransition = Math.random() > 0.4;
    const ts = recentTimestamp(1, 28);

    if (isTransition) {
      const transition = pick(transitions);
      events.push({
        id: generateULID(),
        timestamp: ts,
        ingestedAt: now(),
        source: "jira",
        eventType: "issue.transitioned",
        scope: { org: ORG, project: JIRA_PROJECT, actor: actor.name },
        payload: {
          key: ticket.key,
          title: ticket.title,
          type: ticket.type,
          priority: ticket.priority,
          transition,
          assignee: actor.name,
        },
        summary: `${actor.name} moved ${ticket.key} "${ticket.title}" ${transition}`,
      });
    } else {
      const action = pick(["commented", "updated", "created"] as const);
      events.push({
        id: generateULID(),
        timestamp: ts,
        ingestedAt: now(),
        source: "jira",
        eventType: `issue.${action}`,
        scope: { org: ORG, project: JIRA_PROJECT, actor: actor.name },
        payload: {
          key: ticket.key,
          title: ticket.title,
          type: ticket.type,
          priority: ticket.priority,
          action,
        },
        summary: `${actor.name} ${action} ${ticket.key} "${ticket.title}"`,
      });
    }
  }

  return events;
}

// -- Figma events ---------------------------------------------------------------

export function generateFigmaEvents(): OpenChiefEvent[] {
  const events: OpenChiefEvent[] = [];
  const designers = TEAM.filter(m => m.team === "design" || m.role.includes("Designer"));
  const files = [
    "Dashboard Redesign v3", "Onboarding Flow", "Settings Page",
    "Mobile App Screens", "Component Library", "Marketing Landing Page",
  ];

  if (Math.random() > 0.3) {
    const designer = pick(designers.length ? designers : TEAM);
    const file = pick(files);
    const ts = recentTimestamp(1, 25);

    events.push({
      id: generateULID(),
      timestamp: ts,
      ingestedAt: now(),
      source: "figma",
      eventType: "file.version_updated",
      scope: { org: ORG, project: file, actor: designer.name },
      payload: {
        file_name: file,
        version_label: pick(["", "Ready for review", "Final", "WIP", ""]),
        editor: designer.name,
      },
      summary: `${designer.name} updated "${file}" in Figma`,
    });
  }

  // Occasional comment
  if (Math.random() > 0.5) {
    const commenter = pick(TEAM);
    const file = pick(files);
    const comment = pick([
      "Looks great! The spacing feels much better now",
      "Can we try a darker shade for the background?",
      "The button hierarchy is confusing -- primary and secondary look too similar",
      "Love this direction. Let's present it to the team Thursday",
      "This needs to match the component library tokens",
    ]);
    const ts = recentTimestamp(1, 25);

    events.push({
      id: generateULID(),
      timestamp: ts,
      ingestedAt: now(),
      source: "figma",
      eventType: "file.comment",
      scope: { org: ORG, project: file, actor: commenter.name },
      payload: { file_name: file, comment, commenter: commenter.name },
      summary: `${commenter.name} commented on "${file}": ${comment}`,
    });
  }

  return events;
}

// -- Intercom events ------------------------------------------------------------

export function generateIntercomEvents(): OpenChiefEvent[] {
  const events: OpenChiefEvent[] = [];

  const topics = [
    "Can't access my API keys after upgrading to the pro plan",
    "How do I set up webhooks for my workspace?",
    "Billing question: can I switch from monthly to annual?",
    "Getting a 403 error when trying to create a new project",
    "Feature request: team management for enterprise accounts",
    "The export function is timing out on large datasets",
    "Need help migrating from v1 to v2 of the API",
    "Is there a way to add custom fields to user profiles?",
  ];

  const count = randInt(1, 3);
  for (let i = 0; i < count; i++) {
    const customer = pick(CUSTOMERS);
    const topic = pick(topics);
    const isNew = Math.random() > 0.4;
    const ts = recentTimestamp(1, 28);

    events.push({
      id: generateULID(),
      timestamp: ts,
      ingestedAt: now(),
      source: "intercom",
      eventType: isNew ? "conversation.opened" : "conversation.replied",
      scope: { org: ORG, actor: customer.contact },
      payload: {
        customer_name: customer.name,
        plan: customer.plan,
        contact: customer.contact,
        topic,
        state: isNew ? "open" : "active",
      },
      summary: `${customer.name} (${customer.plan}): ${topic}`,
    });
  }

  return events;
}

// -- Amplitude metrics ----------------------------------------------------------

export function generateAmplitudeEvents(): OpenChiefEvent[] {
  // Metrics snapshot -- emitted less frequently (every other cycle)
  if (Math.random() > 0.5) return [];

  const ts = recentTimestamp(1, 10);
  const dau = randInt(1200, 2800);
  const wau = randInt(5000, 12000);
  const sessionDuration = randFloat(3.5, 8.2);
  const conversionRate = randFloat(2.1, 5.8);

  return [{
    id: generateULID(),
    timestamp: ts,
    ingestedAt: now(),
    source: "amplitude",
    eventType: "metrics.snapshot",
    scope: { org: ORG, project: "platform" },
    payload: {
      dau,
      wau,
      avg_session_duration_min: Math.round(sessionDuration * 10) / 10,
      signup_conversion_rate: Math.round(conversionRate * 100) / 100,
      top_events: ["page_view", "api_call", "dashboard_visit", "export_clicked"],
      retention_d7: randFloat(25, 45),
    },
    summary: `Metrics snapshot: DAU=${dau}, WAU=${wau}, avg session=${sessionDuration.toFixed(1)}min, conversion=${conversionRate.toFixed(1)}%`,
  }];
}

// -- Google Analytics -----------------------------------------------------------

export function generateGoogleAnalyticsEvents(): OpenChiefEvent[] {
  // Less frequent -- every other cycle
  if (Math.random() > 0.4) return [];

  const ts = recentTimestamp(1, 10);
  const pageviews = randInt(3000, 8000);
  const users = randInt(800, 2500);
  const bounceRate = randFloat(35, 55);

  return [{
    id: generateULID(),
    timestamp: ts,
    ingestedAt: now(),
    source: "google-analytics",
    eventType: "traffic.snapshot",
    scope: { org: ORG, project: "greenfield.dev" },
    payload: {
      pageviews,
      active_users: users,
      bounce_rate: Math.round(bounceRate * 10) / 10,
      top_pages: ["/docs/getting-started", "/pricing", "/blog/v2-launch", "/dashboard"],
      top_sources: ["google", "github.com", "twitter.com", "direct"],
      country_breakdown: { US: 42, UK: 12, DE: 8, IN: 7, CA: 6 },
    },
    summary: `Site overview: ${pageviews} pageviews, ${users} users, ${bounceRate.toFixed(1)}% bounce rate`,
  }];
}

// -- Combined generator ---------------------------------------------------------

export function generateEventBatch(): OpenChiefEvent[] {
  return [
    ...generateGitHubEvents(),
    ...generateSlackEvents(),
    ...generateDiscordEvents(),
    ...generateJiraEvents(),
    ...generateFigmaEvents(),
    ...generateIntercomEvents(),
    ...generateAmplitudeEvents(),
    ...generateGoogleAnalyticsEvents(),
  ];
}
