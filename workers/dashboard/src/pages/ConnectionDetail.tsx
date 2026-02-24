import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ChevronRight,
  ChevronDown,
  Save,
  Eye,
  EyeOff,
  Loader2,
  BookOpen,
  Terminal,
  Settings,
  Activity,
  Users,
  Zap,
  RefreshCw,
  CheckCircle2,
  XCircle,
  FolderOpen,
} from "lucide-react";
import { BarChart, Bar, CartesianGrid, XAxis } from "recharts";
import {
  api,
  type ConnectorConfigResponse,
  type ConnectorConfigField,
  type ConnectionEvent,
  type SyncResult,
  type FigmaFile,
  type FigmaFilesResponse,
} from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SourceIcon } from "@/components/SourceIcon";
import { Checkbox } from "@/components/ui/checkbox";

interface AgentAccess {
  id: string;
  name: string;
  tools: string[];
}

interface ConnectionStats {
  volume: { date: string; count: number }[];
  eventTypes: { eventType: string; count: number }[];
  topActors: { actor: string; count: number }[];
}

const EVENT_TYPE_COLORS = [
  "#34d399", "#fbbf24", "#818cf8", "#f87171",
  "#38bdf8", "#fb923c", "#a78bfa", "#4ade80",
  "#f472b6", "#94a3b8",
];

// ---------------------------------------------------------------------------
// Connection Charts
// ---------------------------------------------------------------------------

function EventVolumeChart({ data }: { data: ConnectionStats["volume"] }) {
  const { chartData, totalEvents } = useMemo(() => {
    const byDate: Record<string, number> = {};
    let totalEvents = 0;
    for (const row of data) {
      byDate[row.date] = row.count;
      totalEvents += row.count;
    }
    const chartData: { date: string; label: string; events: number }[] = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      chartData.push({ date: key, label, events: byDate[key] || 0 });
    }
    return { chartData, totalEvents };
  }, [data]);

  const chartConfig: ChartConfig = {
    events: { label: "Events", color: "#34d399" },
  };

  return (
    <Card className="flex flex-col gap-0 py-3">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm">Event Volume</CardTitle>
        <CardDescription className="text-xs">Last 30 days</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pb-0">
        {totalEvents === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground/40">
            <Activity className="h-8 w-8" />
            <span className="text-xs font-medium">No events yet</span>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[120px] w-full">
            <BarChart accessibilityLayer data={chartData} margin={{ left: 0, right: 4, top: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => v.slice(0, 3)} tick={{ fontSize: 10 }} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="events" fill="#34d399" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="pt-1 pb-0 px-4">
        <div className="text-xs text-muted-foreground leading-none">
          {totalEvents > 0
            ? `${totalEvents.toLocaleString()} events in the last 30 days`
            : "Waiting for events"}
        </div>
      </CardFooter>
    </Card>
  );
}

function EventTypesChart({ data }: { data: ConnectionStats["eventTypes"] }) {
  const { chartData, topType } = useMemo(() => {
    const chartData = data.map((row, i) => ({
      type: row.eventType,
      count: row.count,
      fill: EVENT_TYPE_COLORS[i % EVENT_TYPE_COLORS.length],
    }));
    const topType = data.length > 0 ? data[0].eventType : null;
    return { chartData, topType };
  }, [data]);

  const chartConfig: ChartConfig = {};
  for (const row of chartData) {
    chartConfig[row.type] = { label: row.type, color: row.fill };
  }

  return (
    <Card className="flex flex-col gap-0 py-3">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm">Event Types</CardTitle>
        <CardDescription className="text-xs">Top types by volume</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pb-0">
        {data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground/40">
            <Zap className="h-8 w-8" />
            <span className="text-xs font-medium">No events yet</span>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[120px] w-full">
            <BarChart accessibilityLayer data={chartData} margin={{ left: 0, right: 4, top: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="type" tickLine={false} axisLine={false} tickMargin={4} tick={{ fontSize: 9 }} interval={0} angle={-30} textAnchor="end" />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="pt-1 pb-0 px-4">
        <div className="text-xs text-muted-foreground leading-none">
          {topType
            ? `Most common: ${topType}`
            : "Waiting for events"}
        </div>
      </CardFooter>
    </Card>
  );
}

function ConsumersCard({
  agents,
  events,
}: {
  agents: AgentAccess[];
  events: ConnectionEvent[];
}) {
  const lastEvent = events.length > 0 ? events[0] : null;
  const uniqueActors = useMemo(() => {
    const actors = new Set<string>();
    for (const e of events) {
      if (e.actor) actors.add(e.actor);
    }
    return actors.size;
  }, [events]);

  return (
    <Card className="flex flex-col gap-0 py-3">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm">Connection Info</CardTitle>
        <CardDescription className="text-xs">Agents &amp; activity</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pb-0">
        <div className="space-y-3 py-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Subscribing agents</span>
            <span className="text-sm font-medium">{agents.length}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Unique actors</span>
            <span className="text-sm font-medium">{uniqueActors}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Ingestion</span>
            <Badge variant="outline" className="text-xs">Webhook + Poll</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Last event</span>
            <span className="text-xs font-medium">
              {lastEvent ? timeAgo(lastEvent.timestamp) : "—"}
            </span>
          </div>
        </div>
      </CardContent>
      <CardFooter className="pt-1 pb-0 px-4">
        <div className="flex flex-wrap gap-1">
          {agents.slice(0, 5).map((a) => (
            <Link key={a.id} to={`/agents/${a.id}`}>
              <Badge variant="secondary" className="text-xs cursor-pointer hover:bg-accent">
                {a.name}
              </Badge>
            </Link>
          ))}
          {agents.length > 5 && (
            <Badge variant="secondary" className="text-xs">
              +{agents.length - 5} more
            </Badge>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Setup Guide Data
// ---------------------------------------------------------------------------

interface SetupGuideData {
  manual: { step: string; detail: string }[];
  claudeCode?: string;
}

const SETUP_GUIDES: Record<string, SetupGuideData> = {
  github: {
    manual: [
      {
        step: "Create a GitHub App",
        detail:
          'Go to your GitHub organization Settings → Developer settings → GitHub Apps → New GitHub App. Set the app name (e.g. "openchief-internal"), homepage URL to your OpenChief repo, and a description.',
      },
      {
        step: "Configure webhook",
        detail:
          "Set the Webhook URL to your GitHub connector worker URL (e.g. https://your-worker.your-team.workers.dev). Generate a random webhook secret (openssl rand -hex 20) and enter it in the Webhook secret field.",
      },
      {
        step: "Set repository permissions",
        detail:
          "Under Repository permissions, set the following to Read-only: Actions, Commit statuses, Contents, Deployments, Issues, Metadata (mandatory), Pull requests.",
      },
      {
        step: "Subscribe to events",
        detail:
          "Check these event subscriptions: Create, Delete, Deployment, Deployment status, Issue comment, Issues, Pull request, Pull request review, Pull request review comment, Push, Release, Status, Workflow run.",
      },
      {
        step: 'Select "Only on this account" and create the app',
        detail:
          "Keep the app private to your organization. Click Create GitHub App. Note the App ID shown on the next page.",
      },
      {
        step: "Generate a private key",
        detail:
          'Scroll down to "Private keys" on the app settings page and click Generate a private key. A .pem file will download. Convert it to PKCS#8 format: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in downloaded.pem -out pkcs8.pem',
      },
      {
        step: "Install the app",
        detail:
          'Click "Install App" in the sidebar, select your organization, choose "All repositories" (or select specific repos), and click Install. Note the Installation ID from the URL (the number at the end).',
      },
      {
        step: "Enter credentials",
        detail:
          "Fill in the fields below with: App ID, Private Key (PKCS#8 PEM content), Installation ID, Webhook Secret, Repos (comma-separated, e.g. org/repo1,org/repo2), and an Admin Secret for the /poll endpoint.",
      },
    ],
    claudeCode:
      'You can automate the GitHub App setup using Claude Code with browser automation. Use this prompt:\n\n"Create a new GitHub App for OpenChief on my organization. Navigate to GitHub → Organization Settings → Developer Settings → GitHub Apps → New. Fill in the app name, set the webhook URL to my GitHub connector worker URL, generate a webhook secret, set repository permissions (Actions, Commit statuses, Contents, Deployments, Issues, Pull requests — all Read-only), subscribe to events (Create, Delete, Deployment, Deployment status, Issue comment, Issues, Pull request, Pull request review, Pull request review comment, Push, Release, Status, Workflow run), select Only on this account, create the app, generate a private key, install it on the org for all repos, then convert the private key to PKCS#8 and set all the wrangler secrets on the connector worker."',
  },
  slack: {
    manual: [
      {
        step: "Create a Slack App",
        detail:
          "Go to api.slack.com/apps and click Create New App. Choose From an app manifest, select your workspace, then paste the JSON manifest (see Claude Code tab for the full manifest). Alternatively, create From scratch and configure manually.",
      },
      {
        step: "Configure via App Manifest (recommended)",
        detail:
          'If you created from scratch, go to App Manifest in the sidebar and paste the manifest JSON. This sets all permissions and events at once. The manifest configures: Bot scopes (channels:history, channels:join, channels:read, groups:history, groups:read, reactions:read, team:read, users:read, users:read.email), Event subscriptions (message.channels, message.groups, reaction_added, reaction_removed, member_joined_channel, member_left_channel, channel_created, channel_archive, channel_unarchive, team_join), and the webhook request URL.',
      },
      {
        step: "Verify the webhook URL",
        detail:
          "After saving the manifest, Slack will verify your webhook URL. Make sure your Slack connector worker is deployed first. If you see a verification warning, click the verify link. The worker handles the url_verification challenge automatically.",
      },
      {
        step: "Install to workspace",
        detail:
          'Click "Install App" in the sidebar, then "Install to Workspace". Review the permissions and click Allow. Copy the Bot User OAuth Token (xoxb-...) from the page that appears.',
      },
      {
        step: "Get the Signing Secret",
        detail:
          'Go to "Basic Information" in the sidebar. Under App Credentials, copy the Signing Secret. This is used to verify that webhook requests are genuinely from Slack.',
      },
      {
        step: "Enter credentials below",
        detail:
          "Fill in: Bot Token (xoxb-...), Signing Secret, and an Admin Secret (generate one with: openssl rand -hex 32). The bot will auto-join public channels on its first poll and begin backfilling message history.",
      },
    ],
    claudeCode:
      'You can automate the Slack App setup using Claude Code with browser automation. Use this prompt:\n\n"Create a new Slack App for OpenChief on my workspace at api.slack.com. Use the App Manifest approach — navigate to api.slack.com/apps, click Create New App → From an app manifest, select my workspace, and paste this manifest:"\n\n```json\n{\n  "display_information": {\n    "name": "OpenChief",\n    "description": "AI agents that passively watch your tools and produce reports",\n    "background_color": "#0a0a0a"\n  },\n  "features": {\n    "bot_user": {\n      "display_name": "OpenChief",\n      "always_online": true\n    }\n  },\n  "oauth_config": {\n    "scopes": {\n      "bot": [\n        "channels:history", "channels:join", "channels:read",\n        "groups:history", "groups:read", "reactions:read",\n        "team:read", "users:read", "users:read.email"\n      ]\n    }\n  },\n  "settings": {\n    "event_subscriptions": {\n      "request_url": "YOUR_SLACK_CONNECTOR_WORKER_URL/webhook",\n      "bot_events": [\n        "channel_archive", "channel_created", "channel_unarchive",\n        "member_joined_channel", "member_left_channel",\n        "message.channels", "message.groups",\n        "reaction_added", "reaction_removed", "team_join"\n      ]\n    },\n    "org_deploy_enabled": false,\n    "socket_mode_enabled": false,\n    "token_rotation_enabled": false\n  }\n}\n```\n\n"Then install the app to the workspace, copy the Bot Token and Signing Secret, and set the wrangler secrets (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ADMIN_SECRET) on the connector worker."',
  },
  figma: {
    manual: [
      {
        step: "Create a Figma App",
        detail:
          'Go to figma.com/developers/apps and click "Create a new app". Set the name (e.g. "OpenChief"), add a description, and upload a logo if desired.',
      },
      {
        step: "Set the OAuth callback URL",
        detail:
          "In the app settings, set the Callback URL to your Figma connector worker URL + /oauth/callback (e.g. https://openchief-internal-connector-figma.trust-ethos.workers.dev/oauth/callback). This is used when authenticating via OAuth.",
      },
      {
        step: "Set OAuth scopes",
        detail:
          "Under OAuth scopes, add: file_content:read, file_metadata:read, file_versions:read, file_comments:read, library_assets:read, library_content:read, team_library_content:read, file_dev_resources:read, projects:read, webhooks:read, webhooks:write.",
      },
      {
        step: "Copy Client ID and Client Secret",
        detail:
          "Copy the Client ID and Client Secret from the app page. You will set these as wrangler secrets: FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET.",
      },
      {
        step: "Generate a Personal Access Token (fallback)",
        detail:
          'Go to figma.com/developers/api#access-tokens and generate a new Personal Access Token with file:read and webhooks:write scopes. This is used as a fallback when OAuth is not completed.',
      },
      {
        step: "Set a Webhook Passcode",
        detail:
          'Generate a random passcode (openssl rand -hex 20). This passcode validates incoming webhook payloads from Figma. You will set it as the FIGMA_PASSCODE secret and use it when registering webhooks.',
      },
      {
        step: "Find your Figma Team ID",
        detail:
          "Navigate to your Figma team page in the browser. The URL will be like figma.com/files/team/{team_id}/Team-Name. Copy the numeric team_id and enter it in the Team ID field below. This is needed to list projects for the project picker.",
      },
      {
        step: "Enter credentials below",
        detail:
          "Fill in: Personal Access Token, Webhook Passcode, Team ID, and Admin Secret. Additionally, set FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET via wrangler secret put on the connector worker.",
      },
      {
        step: "Initiate OAuth (recommended)",
        detail:
          'After deploying the connector and setting secrets, visit https://YOUR_CONNECTOR_URL/oauth/start?secret=YOUR_ADMIN_SECRET to start the OAuth flow. This grants team-level access and is preferred over personal tokens.',
      },
    ],
    claudeCode:
      'You can automate the Figma App setup using Claude Code with browser automation. Use this prompt:\n\n"Set up a Figma app for OpenChief. Navigate to figma.com/developers/apps and create a new app called \'OpenChief\'. Set the Callback URL to https://MY_FIGMA_CONNECTOR_WORKER_URL/oauth/callback. Add these OAuth scopes: file_content:read, file_metadata:read, file_versions:read, file_comments:read, library_assets:read, library_content:read, team_library_content:read, file_dev_resources:read, projects:read, webhooks:read, webhooks:write. Copy the Client ID and Client Secret. Then generate a Personal Access Token at figma.com/developers/api#access-tokens with file:read and webhooks:write scopes. Set the wrangler secrets on the connector worker: FIGMA_TOKEN (personal token), FIGMA_PASSCODE (random hex: openssl rand -hex 20), FIGMA_CLIENT_ID, FIGMA_CLIENT_SECRET, and ADMIN_SECRET. Finally, initiate the OAuth flow by visiting https://MY_FIGMA_CONNECTOR_WORKER_URL/oauth/start?secret=MY_ADMIN_SECRET."',
  },
};

// ---------------------------------------------------------------------------
// Configuration (unified: setup guide + credentials)
// ---------------------------------------------------------------------------

function SetupGuideContent({ guide }: { guide: SetupGuideData }) {
  const [activeTab, setActiveTab] = useState<"manual" | "claude">(
    guide.claudeCode ? "claude" : "manual",
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Setup Guide</span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {guide.claudeCode && (
          <button
            onClick={() => setActiveTab("claude")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === "claude"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Terminal className="h-3 w-3" />
            Claude Code
          </button>
        )}
        <button
          onClick={() => setActiveTab("manual")}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            activeTab === "manual"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <BookOpen className="h-3 w-3" />
          Manual Setup
        </button>
      </div>

      {activeTab === "manual" ? (
        <ol className="space-y-3">
          {guide.manual.map((item, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium">{item.step}</p>
                <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
                  {item.detail}
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            If you have Claude Code with browser automation (MCP Chrome
            extension), you can automate the entire setup. Copy the prompt below
            and paste it into Claude Code:
          </p>
          <pre className="whitespace-pre-wrap rounded-lg bg-muted p-4 text-xs leading-relaxed">
            {guide.claudeCode}
          </pre>
        </div>
      )}
    </div>
  );
}

function ConfigurationSection({
  source,
  config,
  fieldValues,
  revealedFields,
  hasChanges,
  saving,
  onFieldChange,
  onToggleReveal,
  onSave,
}: {
  source: string;
  config: ConnectorConfigResponse;
  fieldValues: Record<string, string>;
  revealedFields: Set<string>;
  hasChanges: boolean;
  saving: boolean;
  onFieldChange: (key: string, value: string) => void;
  onToggleReveal: (key: string) => void;
  onSave: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const guide = SETUP_GUIDES[source] ?? null;

  return (
    <Card>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-6 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          <Settings className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Configuration</span>
          <span className="text-xs text-muted-foreground">
            {guide ? "Setup guide, credentials & settings" : "Manage connection credentials and settings"}
          </span>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <CardContent className="space-y-6 pt-0">
          {/* Setup Guide (if available for this source) */}
          {guide && (
            <>
              <SetupGuideContent guide={guide} />
              <Separator />
            </>
          )}

          {/* Credential Fields */}
          <div className="space-y-4">
            {config.fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                value={fieldValues[field.key] ?? ""}
                revealed={revealedFields.has(field.key)}
                onValueChange={(v) => onFieldChange(field.key, v)}
                onToggleReveal={() => onToggleReveal(field.key)}
              />
            ))}
            <div className="flex justify-end pt-2">
              <Button
                onClick={onSave}
                disabled={!hasChanges || saving}
                size="sm"
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sync Result Details (connector-specific formatting)
// ---------------------------------------------------------------------------

function SyncResultDetails({ source, result }: { source: string; result: SyncResult }) {
  if (!result.ok) {
    return (
      <Card className="border-destructive/50 bg-destructive/5">
        <CardContent className="flex items-start gap-3 py-4">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">Sync failed</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {result.error ?? "Unknown error"}
              {result.detail && (
                <span className="block mt-1 font-mono">{result.detail}</span>
              )}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const data = result as Record<string, unknown>;
  // The backend spreads the connector response, so nested data lives under `result`
  const nested = (data.result && typeof data.result === "object" ? data.result : data) as Record<string, unknown>;

  // Identity sync result — connector returns { userSync: { synced, skipped } }
  const userSync = nested.userSync as Record<string, number> | undefined;
  if (userSync) {
    const parts: string[] = [];
    if (userSync.synced !== undefined) parts.push(`Users synced: ${userSync.synced}`);
    if (userSync.skipped !== undefined) parts.push(`Skipped: ${userSync.skipped}`);

    return (
      <Card className="border-emerald-500/50 bg-emerald-500/5">
        <CardContent className="flex items-start gap-3 py-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Humans synced</p>
            {parts.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">{parts.join(" · ")}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Human sync completed</p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Generic fallback
  return (
    <Card className="border-emerald-500/50 bg-emerald-500/5">
      <CardContent className="flex items-start gap-3 py-4">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div>
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Sync completed</p>
          <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
            {JSON.stringify(nested, null, 2)}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Project Picker (Figma)
// ---------------------------------------------------------------------------

function FilePickerSection({ source }: { source: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<FigmaFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initialSelected, setInitialSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<FigmaFilesResponse>(
        `connections/${source}/projects`,
      );
      if (!data.ok) {
        setError(data.error || "Failed to load files");
        return;
      }
      setFiles(data.files);
      const sel = new Set(data.selected);
      setSelected(sel);
      setInitialSelected(new Set(sel));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    if (expanded && files.length === 0 && !loading && !error) {
      loadFiles();
    }
  }, [expanded, files.length, loading, error, loadFiles]);

  const hasChanges = useMemo(() => {
    if (selected.size !== initialSelected.size) return true;
    for (const key of selected) {
      if (!initialSelected.has(key)) return true;
    }
    return false;
  }, [selected, initialSelected]);

  function toggleFile(fileKey: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.put(`connections/${source}/projects`, {
        fileKeys: [...selected],
      });
      setInitialSelected(new Set(selected));
    } catch (err) {
      console.error("Failed to save file selection:", err);
    } finally {
      setSaving(false);
    }
  }

  const filtered = files.filter((f) =>
    f.name.toLowerCase().includes(filter.toLowerCase()) ||
    f.projectName.toLowerCase().includes(filter.toLowerCase()),
  );

  // Group by project for display
  const grouped = useMemo(() => {
    const groups: Record<string, { projectName: string; files: FigmaFile[] }> = {};
    for (const f of filtered) {
      if (!groups[f.projectId]) {
        groups[f.projectId] = { projectName: f.projectName, files: [] };
      }
      groups[f.projectId].files.push(f);
    }
    return Object.entries(groups);
  }, [filtered]);

  return (
    <Card>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-6 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Watched Files</span>
          <span className="text-xs text-muted-foreground">
            {selected.size > 0
              ? `${selected.size} file${selected.size > 1 ? "s" : ""} selected`
              : "Select which Figma files to monitor"}
          </span>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <CardContent className="space-y-4 pt-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading files from Figma...</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
              <p className="text-sm text-destructive">{error}</p>
              {error.includes("Team ID") && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Set the Team ID in the Configuration section above, then try
                  again.
                </p>
              )}
            </div>
          ) : (
            <>
              {files.length > 5 && (
                <Input
                  placeholder="Filter files..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="text-sm"
                />
              )}
              <div className="max-h-72 space-y-3 overflow-y-auto">
                {grouped.map(([projectId, group]) => (
                  <div key={projectId}>
                    {grouped.length > 1 && (
                      <p className="mb-1 px-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {group.projectName}
                      </p>
                    )}
                    <div className="space-y-1">
                      {group.files.map((file) => (
                        <label
                          key={file.key}
                          className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted"
                        >
                          <Checkbox
                            checked={selected.has(file.key)}
                            onCheckedChange={() => toggleFile(file.key)}
                          />
                          <span className="text-sm">{file.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    {files.length === 0
                      ? "No files found"
                      : "No matches"}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between pt-2">
                <p className="text-xs text-muted-foreground">
                  {selected.size === 0
                    ? "No files selected — all files will be monitored"
                    : `${selected.size} of ${files.length} files will be monitored`}
                </p>
                <Button
                  onClick={handleSave}
                  disabled={!hasChanges || saving}
                  size="sm"
                >
                  {saving ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="mr-1.5 h-3.5 w-3.5" />
                      Save Selection
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ConnectionDetail
// ---------------------------------------------------------------------------

export function ConnectionDetail() {
  const { source } = useParams<{ source: string }>();
  const [config, setConfig] = useState<ConnectorConfigResponse | null>(null);
  const [events, setEvents] = useState<ConnectionEvent[]>([]);
  const [agentAccess, setAgentAccess] = useState<AgentAccess[]>([]);
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const loadData = useCallback(async () => {
    if (!source) return;
    try {
      const [configData, eventData, accessData, statsData] = await Promise.all([
        api
          .get<ConnectorConfigResponse>(`connections/${source}/settings`)
          .catch(() => null),
        api
          .get<ConnectionEvent[]>(`connections/${source}/events?limit=100`)
          .catch(() => []),
        api
          .get<{ agents: AgentAccess[] }>(`connections/${source}/access`)
          .then((d) => d?.agents ?? [])
          .catch(() => []),
        api
          .get<ConnectionStats>(`connections/${source}/stats`)
          .catch(() => null),
      ]);
      setConfig(configData);
      setEvents(eventData);
      setStats(statsData);
      setAgentAccess(accessData);
    } catch (err) {
      console.error("Failed to load connection:", err);
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function handleFieldChange(key: string, value: string) {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  }

  function toggleReveal(key: string) {
    setRevealedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function handleSave() {
    if (!source) return;
    setSaving(true);
    try {
      await api.put(`connections/${source}/settings`, fieldValues);
      setFieldValues({});
      await loadData();
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    if (!source) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await api.post<SyncResult>(`connections/${source}/sync`);
      setSyncResult(result);
      // Refresh page data after a short delay on success
      if (result.ok) {
        setTimeout(() => loadData(), 2000);
      }
    } catch (err) {
      setSyncResult({
        ok: false,
        error: err instanceof Error ? err.message : "Sync request failed",
      });
    } finally {
      setSyncing(false);
    }
  }

  // Check if ADMIN_SECRET is configured (needed for sync)
  const adminSecretConfigured = config?.fields.some(
    (f) => f.key === "ADMIN_SECRET" && f.configured,
  ) ?? false;

  const hasChanges = Object.keys(fieldValues).length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="capitalize">{config?.label ?? source}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <SourceIcon name={source ?? ""} />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {config?.label ?? source}
            </h1>
            {config?.workerName && (
              <p className="text-sm text-muted-foreground">
                Worker: {config.workerName}
              </p>
            )}
          </div>
        </div>
        {adminSecretConfigured && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Sync Humans
              </>
            )}
          </Button>
        )}
      </div>

      {/* Sync Result */}
      {syncResult && source && (
        <SyncResultDetails source={source} result={syncResult} />
      )}

      {/* Charts */}
      {stats && events.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <EventVolumeChart data={stats.volume} />
          <EventTypesChart data={stats.eventTypes} />
          <ConsumersCard agents={agentAccess} events={events} />
        </div>
      )}

      {/* Configuration (setup guide + credentials) */}
      {config && config.fields.length > 0 && source && (
        <ConfigurationSection
          source={source}
          config={config}
          fieldValues={fieldValues}
          revealedFields={revealedFields}
          hasChanges={hasChanges}
          saving={saving}
          onFieldChange={handleFieldChange}
          onToggleReveal={toggleReveal}
          onSave={handleSave}
        />
      )}

      {/* File Picker (Figma only) */}
      {source === "figma" && adminSecretConfigured && (
        <FilePickerSection source={source} />
      )}

      {/* Recent Events */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Events</CardTitle>
          <CardDescription>
            Last {events.length} events from this source
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length > 0 ? (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event Type</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => {
                    const isExec = event.tags?.includes("exec");
                    return (
                      <TableRow
                        key={event.id}
                        className={isExec ? "opacity-60" : undefined}
                      >
                        <TableCell>
                          <span className="flex items-center gap-1.5">
                            <Badge variant="outline" className="text-xs">
                              {event.eventType}
                            </Badge>
                            {isExec && (
                              <Badge className="bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0 dark:bg-amber-900/40 dark:text-amber-300">
                                Exec
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-xs truncate text-sm">
                          {isExec ? (
                            <span className="italic text-muted-foreground">
                              Private channel activity
                            </span>
                          ) : (
                            event.summary
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {isExec ? "---" : (event.actor ?? "--")}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {isExec ? "---" : (event.project ?? "--")}
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {timeAgo(event.timestamp)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No events recorded yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FieldRow sub-component
// ---------------------------------------------------------------------------

function FieldRow({
  field,
  value,
  revealed,
  onValueChange,
  onToggleReveal,
}: {
  field: ConnectorConfigField;
  value: string;
  revealed: boolean;
  onValueChange: (value: string) => void;
  onToggleReveal: () => void;
}) {
  const showMasked = field.secret && field.configured && !value && !revealed;
  const isMultiline = field.key.includes("private_key") || field.key.includes("pem");

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={field.key}>
          {field.label}
          {field.required && (
            <span className="ml-0.5 text-destructive">*</span>
          )}
        </Label>
        {field.configured && (
          <Badge variant="secondary" className="text-xs">
            Configured
          </Badge>
        )}
      </div>
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      <div className="flex gap-2">
        {isMultiline && !showMasked ? (
          <Textarea
            id={field.key}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={field.placeholder ?? undefined}
            className="min-h-[80px] font-mono text-sm"
            rows={4}
          />
        ) : (
          <Input
            id={field.key}
            type={field.secret && !revealed ? "password" : "text"}
            value={showMasked ? (field.maskedValue ?? "") : value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={field.placeholder ?? undefined}
            disabled={showMasked}
            className="font-mono text-sm"
          />
        )}
        {field.secret && (
          <Button
            variant="outline"
            size="icon"
            onClick={onToggleReveal}
            type="button"
          >
            {revealed ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
      {field.updatedAt && (
        <p className="text-xs text-muted-foreground">
          Last updated {timeAgo(field.updatedAt)}
        </p>
      )}
    </div>
  );
}
