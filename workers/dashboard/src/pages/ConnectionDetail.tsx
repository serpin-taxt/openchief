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
  Hash,
  Twitter,
  Search,
  Plus,
  Trash2,
  ExternalLink,
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
  type DiscordChannel,
  type DiscordChannelsResponse,
  type TwitterAccount,
  type TwitterAccountsResponse,
  type TwitterSearchQueriesResponse,
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
          "In the app settings, set the Callback URL to your Figma connector worker URL + /oauth/callback (e.g. https://your-figma-connector.your-team.workers.dev/oauth/callback). This is used when authenticating via OAuth.",
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
  intercom: {
    manual: [
      {
        step: "Create an Intercom Developer App",
        detail:
          'Go to developers.intercom.com and sign in with your Intercom workspace admin account. Click "Your Apps" in the top nav, then "New App". Give it a name like "OpenChief" and select your workspace.',
      },
      {
        step: "Configure the webhook URL",
        detail:
          'In your app settings, go to Webhooks. Set the Webhook URL to your Intercom connector worker URL followed by /webhook (e.g. https://your-worker.your-team.workers.dev/webhook).',
      },
      {
        step: "Select webhook topics",
        detail:
          "In the Webhooks section, select the topics you want to receive in real-time. Recommended defaults: conversation.user.replied, conversation.admin.replied, conversation.admin.noted, conversation.admin.closed, ticket.created. You can also manage which topics OpenChief processes using the Webhook Topics section below.",
      },
      {
        step: "Get your Access Token",
        detail:
          "Go to Authentication in the sidebar. Copy the Access Token — this is used by the connector to poll for conversation data via the Intercom API.",
      },
      {
        step: "Get your Client Secret",
        detail:
          "Go to Basic Information in the sidebar. Copy the Client Secret — this is used to verify the HMAC-SHA1 signature on incoming webhooks, ensuring they genuinely came from Intercom.",
      },
      {
        step: "Enter credentials below",
        detail:
          'Fill in the fields below with: Access Token, Client Secret, and an Admin Secret (generate one with: openssl rand -hex 32). The Admin Secret protects the connector\'s poll, backfill, and webhook topic management endpoints. The connector polls for conversations every 30 minutes automatically — webhooks are optional for richer real-time coverage.',
      },
    ],
    claudeCode:
      'You can automate the Intercom Developer Hub setup using Claude Code with browser automation. Use this prompt:\n\n"Set up an Intercom app for OpenChief. Navigate to developers.intercom.com, sign in, and create a new app called \'OpenChief\' for my workspace. Then go to Webhooks settings and set the webhook URL to MY_INTERCOM_CONNECTOR_WORKER_URL/webhook. Select these webhook topics: conversation.user.replied, conversation.admin.replied, conversation.admin.noted, conversation.admin.closed, ticket.created. Then go to Authentication and copy the Access Token. Go to Basic Information and copy the Client Secret. Finally, generate an Admin Secret (openssl rand -hex 32) and set all three as wrangler secrets on the connector worker:\n\necho \'TOKEN_VALUE\' | wrangler secret put INTERCOM_ACCESS_TOKEN\necho \'SECRET_VALUE\' | wrangler secret put INTERCOM_CLIENT_SECRET\necho \'ADMIN_VALUE\' | wrangler secret put ADMIN_SECRET"',
  },
  amplitude: {
    manual: [
      {
        step: "Log in to Amplitude",
        detail:
          "Go to app.amplitude.com and sign in with your Amplitude account. Make sure you have admin access to the organization.",
      },
      {
        step: "Navigate to Project Settings",
        detail:
          'Click the gear icon (⚙) in the top-right corner → Organization settings. In the sidebar, click "Projects", then click the project you want to connect (e.g. "Ethos (prod)").',
      },
      {
        step: "Copy the API Key",
        detail:
          'On the project\'s General tab, find "API Key" and click "Manage". This opens the API Keys page where you can copy the key value. You can also generate a new API key here if needed.',
      },
      {
        step: "Copy the Secret Key",
        detail:
          'Go back to Settings → Projects → your project → General. Find "Secret Key" and click "Show" to reveal it. Copy this value — it\'s used together with the API Key for Basic Auth on the Amplitude REST API.',
      },
      {
        step: "Enter credentials below",
        detail:
          "Fill in the API Key, Secret Key, and optionally a Project Name (a label like the project name in Amplitude, e.g. \"Ethos (prod)\"). The connector polls Amplitude every 6 hours for DAU/WAU/MAU, user composition, and retention metrics — no webhooks needed.",
      },
    ],
    claudeCode:
      'Amplitude setup is simple — it\'s a pull-only connector with no webhooks. Use this prompt:\n\n"Set up Amplitude for OpenChief. Navigate to app.amplitude.com → Settings (gear icon top-right) → Organization settings → Projects → click my production project. On the General tab, copy the API Key (click Manage) and Secret Key (click Show). Then go to my OpenChief dashboard at MY_DASHBOARD_URL/connections/amplitude and enter the API Key and Secret Key in the Configuration section. Set the Project Name to the name of my Amplitude project. Click Save, then click Sync Humans to trigger the first data pull."',
  },
  discord: {
    manual: [
      {
        step: "Create a Discord Application",
        detail:
          'Go to discord.com/developers/applications and click "New Application". Give it a name like "OpenChief" and accept the Terms of Service.',
      },
      {
        step: "Create a Bot",
        detail:
          'In your application settings, go to "Bot" in the sidebar. Click "Add Bot" if prompted. Under Privileged Gateway Intents, enable "Message Content Intent" (required to read message text). Copy the Bot Token — you\'ll need it below.',
      },
      {
        step: "Set bot permissions",
        detail:
          'Go to "OAuth2" → "URL Generator" in the sidebar. Under Scopes, check "bot". Under Bot Permissions, check: Read Messages/View Channels, Read Message History. Copy the generated URL at the bottom.',
      },
      {
        step: "Invite the bot to your server",
        detail:
          "Open the generated URL in your browser. Select the Discord server (guild) you want to connect, and click Authorize. The bot will appear in the server member list.",
      },
      {
        step: "Get the Guild ID and Public Key",
        detail:
          'In Discord, enable Developer Mode (User Settings → App Settings → Advanced → Developer Mode). Right-click your server name and click "Copy Server ID" — this is the Guild ID. Back in the Developer Portal, find the Public Key on the General Information page of your application.',
      },
      {
        step: "Configure the webhook (optional)",
        detail:
          'In the Developer Portal, go to "General Information". Set the Interactions Endpoint URL to your Discord connector worker URL followed by /webhook (e.g. https://your-worker.workers.dev/webhook). Discord will verify the endpoint with a PING. This is optional — the connector primarily uses polling.',
      },
      {
        step: "Enter credentials below",
        detail:
          'Fill in: Bot Token, Public Key, Guild ID, and an Admin Secret (generate one with: openssl rand -hex 32). After saving, expand the "Monitored Channels" section below to select which channels to watch. The bot polls every 30 minutes automatically.',
      },
    ],
    claudeCode:
      'You can automate the Discord bot setup using Claude Code with browser automation. Use this prompt:\n\n"Set up a Discord bot for OpenChief. Navigate to discord.com/developers/applications, create a new application called \'OpenChief\'. Go to Bot settings, enable Message Content Intent, and copy the Bot Token. Go to OAuth2 → URL Generator, select the \'bot\' scope, add Read Messages/View Channels and Read Message History permissions, then open the generated URL to invite the bot to my server. Copy the Guild ID (Server ID) from Discord and the Public Key from the Developer Portal. Then enter the Bot Token, Public Key, Guild ID, and a generated Admin Secret (openssl rand -hex 32) in the OpenChief dashboard at MY_DASHBOARD_URL/connections/discord."',
  },
  twitter: {
    manual: [
      {
        step: "Create an X Developer App",
        detail:
          'Go to developer.x.com and sign in. Navigate to the Developer Portal → Projects & Apps → Create App (or add an app to an existing project). Name it "OpenChief", and select the appropriate access level (at minimum "Read").',
      },
      {
        step: "Get the Bearer Token",
        detail:
          'In the app\'s "Keys and tokens" tab, find the "Bearer Token" under the App-only section. Click Generate (or Regenerate) and copy the token. This is used for reading public tweets and search.',
      },
      {
        step: "Set up OAuth 2.0 (for mentions)",
        detail:
          'In app Settings → "User authentication settings" → click Set up. Choose App permissions: Read. App type: Confidential client. Set the Callback URL to https://YOUR_TWITTER_CONNECTOR_URL/oauth/callback. Set the Website URL to any valid URL. Save the settings.',
      },
      {
        step: "Copy OAuth credentials",
        detail:
          "After saving OAuth settings, you'll be shown the Client ID and Client Secret. Copy both — you'll need them below. The Client Secret is only shown once, so save it securely.",
      },
      {
        step: "Enter credentials below",
        detail:
          "Fill in: Bearer Token, OAuth Client ID, OAuth Client Secret, and an Admin Secret (generate one with: openssl rand -hex 32). Save the configuration.",
      },
      {
        step: "Add monitored accounts",
        detail:
          'Expand the "Monitored Accounts" section below to add X accounts to track. Add your own account(s) and any competitor accounts. Own accounts can connect OAuth for mentions tracking; competitor accounts will track public tweets and engagement only.',
      },
      {
        step: "Connect OAuth for own accounts",
        detail:
          'In the Monitored Accounts section, click "Connect OAuth" next to accounts you own. This opens an X authorization page — log in as that account and authorize. OAuth enables tracking mentions and replies directed at your account.',
      },
    ],
    claudeCode:
      'You can automate the X Developer App setup using Claude Code with browser automation. Use this prompt:\n\n"Set up an X/Twitter app for OpenChief. Navigate to developer.x.com → Developer Portal → Projects & Apps → Create a new app. Name it \'OpenChief\', select Read access. Go to Keys and tokens tab and generate a Bearer Token. Then go to User authentication settings → Set up → App permissions: Read, Type: Confidential client, Callback URL: https://MY_TWITTER_CONNECTOR_URL/oauth/callback, Website URL: https://github.com/openchief/openchief. Copy the Client ID and Client Secret. Then enter all credentials (Bearer Token, OAuth Client ID, OAuth Client Secret, and a generated Admin Secret via openssl rand -hex 32) in the OpenChief dashboard at MY_DASHBOARD_URL/connections/twitter."',
  },
  googleanalytics: {
    manual: [
      {
        step: "Create a Google Cloud project (or use existing)",
        detail:
          "Go to console.cloud.google.com. Select an existing project or create a new one. This project will hold the service account that reads your GA4 data.",
      },
      {
        step: "Enable the Google Analytics Data API",
        detail:
          'In the Google Cloud Console, go to APIs & Services → Library. Search for "Google Analytics Data API" and click Enable. This is the v1 Data API (not the older Reporting API or Admin API).',
      },
      {
        step: "Create a service account",
        detail:
          'Go to APIs & Services → Credentials → Create Credentials → Service Account. Name it something like "openchief-ga4-reader". No special roles needed at the GCP level — access is granted in GA4 itself.',
      },
      {
        step: "Download the service account key",
        detail:
          "Click on the new service account → Keys tab → Add Key → Create new key → JSON. A JSON file will download — this is your service account key. Keep it safe; you'll paste its contents below.",
      },
      {
        step: "Grant the service account access in GA4",
        detail:
          'Go to analytics.google.com → Admin → your GA4 property → Property Access Management. Click the + button → Add users. Enter the service account email (it looks like name@project.iam.gserviceaccount.com). Set the role to "Viewer" — read-only access is all the connector needs.',
      },
      {
        step: "Find your GA4 Property ID",
        detail:
          "In GA4, go to Admin → Property Settings. The Property ID is a 9-digit number shown near the top of the page (e.g. 123456789). This is NOT the Measurement ID (G-XXXX) — it's the numeric property identifier.",
      },
      {
        step: "Enter credentials below",
        detail:
          "Paste the full JSON contents of the downloaded service account key file into the Service Account Key field. Enter the numeric GA4 Property ID. Generate an Admin Secret (openssl rand -hex 32) for the connector's admin endpoints. The connector polls GA4 every 6 hours for page views, traffic sources, referrers, geography, and site overview — no webhooks needed.",
      },
    ],
    claudeCode:
      'Google Analytics setup requires manual steps in two consoles (Google Cloud + GA4). Use this prompt:\n\n"Set up Google Analytics for OpenChief. Navigate to console.cloud.google.com, select (or create) a project, go to APIs & Services → Library and enable the \'Google Analytics Data API\'. Then go to APIs & Services → Credentials → Create Credentials → Service Account, name it \'openchief-ga4-reader\'. Click the service account → Keys → Add Key → Create new key → JSON, and save the downloaded file. Copy the service account email address. Then go to analytics.google.com → Admin → Property Access Management, add the service account email as a Viewer. Note the numeric Property ID from Admin → Property Settings. Finally, in the OpenChief dashboard at MY_DASHBOARD_URL/connections/googleanalytics, paste the JSON key file contents, enter the Property ID, and set an Admin Secret (openssl rand -hex 32). Click Save."',
  },
  notion: {
    manual: [
      {
        step: "Create a Notion integration",
        detail:
          'Go to notion.so/profile/integrations and click "Create a new integration". Name it (e.g. "OpenChief"), select Type: Internal, and choose the workspace you want to monitor. Click Create.',
      },
      {
        step: "Configure capabilities",
        detail:
          "On the integration settings page, under Capabilities, ensure these are checked: Read content, Read comments, and Read user information including email addresses. The connector only reads data — write permissions are optional. Click Save.",
      },
      {
        step: "Copy the integration token",
        detail:
          'On the Configuration tab, find "Internal integration secret" and click Show. Copy the token (starts with ntn_...). This is your Integration Token for the field below.',
      },
      {
        step: "Grant access to pages and databases",
        detail:
          'Go to the Content access tab and click "Edit access". Select the teamspaces, pages, or databases you want OpenChief to monitor. Granting access to a parent page includes all its children. Click Save.',
      },
      {
        step: "Enter credentials below",
        detail:
          "Paste the integration token into the Integration Token field. Generate an Admin Secret (openssl rand -hex 32) for the connector's admin endpoints. The connector polls Notion every 15 minutes for page updates, database entry changes, and new comments.",
      },
    ],
    claudeCode:
      'Notion setup is straightforward. Use this prompt:\n\n"Set up Notion for OpenChief. Navigate to notion.so/profile/integrations, create a new Internal integration named \'OpenChief\' for your workspace. Under Capabilities, enable Read content, Read comments, and Read user information including email addresses. Save, then copy the Internal integration secret (starts with ntn_...). Go to the Content access tab, click Edit access, and select the teamspaces or pages to monitor. In the OpenChief dashboard at MY_DASHBOARD_URL/connections/notion, paste the integration token and set an Admin Secret (openssl rand -hex 32). Click Save."',
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
// Channel Picker (Discord)
// ---------------------------------------------------------------------------

function ChannelPickerSection({ source }: { source: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initialSelected, setInitialSelected] = useState<Set<string>>(
    new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const loadChannels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<DiscordChannelsResponse>(
        `connections/${source}/channels`,
      );
      if (!data.ok) {
        setError(data.error || "Failed to load channels");
        return;
      }
      setChannels(data.channels);
      const sel = new Set(data.selected);
      setSelected(sel);
      setInitialSelected(new Set(sel));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load channels",
      );
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    if (expanded && channels.length === 0 && !loading && !error) {
      loadChannels();
    }
  }, [expanded, channels.length, loading, error, loadChannels]);

  const hasChanges = useMemo(() => {
    if (selected.size !== initialSelected.size) return true;
    for (const id of selected) {
      if (!initialSelected.has(id)) return true;
    }
    return false;
  }, [selected, initialSelected]);

  function toggleChannel(channelId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.put(`connections/${source}/channels`, {
        channelIds: [...selected],
      });
      setInitialSelected(new Set(selected));
    } catch (err) {
      console.error("Failed to save channel selection:", err);
    } finally {
      setSaving(false);
    }
  }

  const filtered = channels.filter(
    (ch) =>
      ch.name.toLowerCase().includes(filter.toLowerCase()) ||
      ch.categoryName.toLowerCase().includes(filter.toLowerCase()),
  );

  // Group by category for display
  const grouped = useMemo(() => {
    const groups: Record<
      string,
      { categoryName: string; channels: DiscordChannel[] }
    > = {};
    for (const ch of filtered) {
      const key = ch.categoryId || "__none__";
      if (!groups[key]) {
        groups[key] = { categoryName: ch.categoryName, channels: [] };
      }
      groups[key].channels.push(ch);
    }
    return Object.entries(groups);
  }, [filtered]);

  const channelTypeLabel = (type: number): string => {
    switch (type) {
      case 5:
        return "announcement";
      case 15:
        return "forum";
      default:
        return "";
    }
  };

  return (
    <Card>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-6 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          <Hash className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Monitored Channels</span>
          <span className="text-xs text-muted-foreground">
            {selected.size > 0
              ? `${selected.size} channel${selected.size > 1 ? "s" : ""} selected`
              : "Select which Discord channels to monitor"}
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
              <span className="text-sm">
                Loading channels from Discord...
              </span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          ) : (
            <>
              {channels.length > 10 && (
                <Input
                  placeholder="Filter channels..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="text-sm"
                />
              )}
              <div className="max-h-72 space-y-3 overflow-y-auto">
                {grouped.map(([categoryId, group]) => (
                  <div key={categoryId}>
                    <p className="mb-1 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {group.categoryName}
                    </p>
                    <div className="space-y-1">
                      {group.channels.map((ch) => (
                        <label
                          key={ch.id}
                          className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted"
                        >
                          <Checkbox
                            checked={selected.has(ch.id)}
                            onCheckedChange={() => toggleChannel(ch.id)}
                          />
                          <span className="text-sm">#{ch.name}</span>
                          {channelTypeLabel(ch.type) && (
                            <Badge
                              variant="secondary"
                              className="text-[10px]"
                            >
                              {channelTypeLabel(ch.type)}
                            </Badge>
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    {channels.length === 0 ? "No channels found" : "No matches"}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between pt-2">
                <p className="text-xs text-muted-foreground">
                  {selected.size === 0
                    ? "No channels selected — all channels will be monitored"
                    : `${selected.size} of ${channels.length} channels will be monitored`}
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
// Webhook Topics Selector (Intercom)
// ---------------------------------------------------------------------------

interface WebhookTopic {
  topic: string;
  selected: boolean;
  isDefault: boolean;
}

interface WebhookTopicsResponse {
  ok: boolean;
  topics: WebhookTopic[];
  selected: string[];
  error?: string;
}

function WebhookTopicsSection({ source }: { source: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [topics, setTopics] = useState<WebhookTopic[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initialSelected, setInitialSelected] = useState<Set<string>>(
    new Set(),
  );
  const [error, setError] = useState<string | null>(null);

  const loadTopics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<WebhookTopicsResponse>(
        `connections/${source}/webhook-topics`,
      );
      if (!data.ok) {
        setError(data.error || "Failed to load webhook topics");
        return;
      }
      setTopics(data.topics);
      const sel = new Set(data.selected);
      setSelected(sel);
      setInitialSelected(new Set(sel));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load webhook topics",
      );
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    if (expanded && topics.length === 0 && !loading && !error) {
      loadTopics();
    }
  }, [expanded, topics.length, loading, error, loadTopics]);

  const hasChanges = useMemo(() => {
    if (selected.size !== initialSelected.size) return true;
    for (const key of selected) {
      if (!initialSelected.has(key)) return true;
    }
    return false;
  }, [selected, initialSelected]);

  function toggleTopic(topic: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  }

  function selectDefaults() {
    setSelected(
      new Set(topics.filter((t) => t.isDefault).map((t) => t.topic)),
    );
  }

  function selectAll() {
    setSelected(new Set(topics.map((t) => t.topic)));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.put(`connections/${source}/webhook-topics`, {
        topics: [...selected],
      });
      setInitialSelected(new Set(selected));
    } catch (err) {
      console.error("Failed to save webhook topics:", err);
    } finally {
      setSaving(false);
    }
  }

  // Group topics by category (conversation, ticket, contact, user)
  const grouped = useMemo(() => {
    const groups: Record<string, WebhookTopic[]> = {};
    for (const t of topics) {
      const prefix = t.topic.split(".")[0];
      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push(t);
    }
    return Object.entries(groups);
  }, [topics]);

  return (
    <Card>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-6 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Webhook Topics</span>
          <span className="text-xs text-muted-foreground">
            {selected.size > 0
              ? `${selected.size} topic${selected.size > 1 ? "s" : ""} active`
              : "Select which events to process"}
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
              <span className="text-sm">Loading webhook topics...</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Select which Intercom webhook events OpenChief should process.
                Unselected topics will be silently dropped. Polling (conversation
                data every 30 minutes) runs independently and is not affected by
                this selection.
              </p>

              {/* Quick actions */}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={selectDefaults}>
                  Defaults
                </Button>
                <Button variant="outline" size="sm" onClick={selectAll}>
                  Select All
                </Button>
              </div>

              <div className="max-h-72 space-y-3 overflow-y-auto">
                {grouped.map(([prefix, groupTopics]) => (
                  <div key={prefix}>
                    <p className="mb-1 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {prefix}
                    </p>
                    <div className="space-y-1">
                      {groupTopics.map((t) => (
                        <label
                          key={t.topic}
                          className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted"
                        >
                          <Checkbox
                            checked={selected.has(t.topic)}
                            onCheckedChange={() => toggleTopic(t.topic)}
                          />
                          <span className="font-mono text-sm">{t.topic}</span>
                          {t.isDefault && (
                            <Badge variant="secondary" className="text-[10px]">
                              default
                            </Badge>
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between pt-2">
                <p className="text-xs text-muted-foreground">
                  {selected.size === 0
                    ? "No topics selected — all webhook events will be dropped"
                    : `${selected.size} of ${topics.length} topics will be processed`}
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
                      Save Topics
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
// Monitored Accounts (Twitter / X)
// ---------------------------------------------------------------------------

function MonitoredAccountsSection({ source }: { source: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accounts, setAccounts] = useState<TwitterAccount[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectingAccount, setConnectingAccount] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<TwitterAccountsResponse>(
        `connections/${source}/accounts`,
      );
      if (data.ok) {
        setAccounts(data.accounts);
      } else {
        setError(data.error ?? "Failed to load accounts");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [source]);

  useEffect(() => {
    if (expanded && !loaded && !loading) {
      loadAccounts();
    }
  }, [expanded, loaded, loading, loadAccounts]);

  const addAccount = () => {
    const cleaned = newUsername.trim().replace(/^@/, "").toLowerCase();
    if (!cleaned) return;
    if (accounts.some((a) => a.username === cleaned)) return;
    setAccounts((prev) => [
      ...prev,
      { username: cleaned, userId: null, oauthConnected: false, expiresAt: null },
    ]);
    setNewUsername("");
    setDirty(true);
  };

  const removeAccount = (username: string) => {
    setAccounts((prev) => prev.filter((a) => a.username !== username));
    setDirty(true);
  };

  const saveAccounts = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put(`connections/${source}/accounts`, {
        accounts: accounts.map((a) => a.username),
      });
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save accounts");
    } finally {
      setSaving(false);
    }
  };

  const connectOAuth = async (username: string) => {
    setConnectingAccount(username);
    try {
      const data = await api.get<{ ok: boolean; authorizationUrl: string }>(
        `connections/${source}/oauth/authorize?account=${encodeURIComponent(username)}`,
      );
      if (data.ok && data.authorizationUrl) {
        window.open(data.authorizationUrl, "_blank");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start OAuth");
    } finally {
      setConnectingAccount(null);
    }
  };

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <Twitter className="h-4 w-4 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Monitored Accounts</CardTitle>
            <CardDescription>
              {accounts.length > 0
                ? `${accounts.length} account${accounts.length === 1 ? "" : "s"} monitored`
                : "Add X accounts to monitor tweets and mentions"}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                Loading accounts...
              </span>
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <>
              {/* Add account input */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    @
                  </span>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addAccount();
                    }}
                    placeholder="username"
                    className="h-9 w-full rounded-md border bg-background pl-7 pr-3 text-sm"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={addAccount}
                  disabled={!newUsername.trim()}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </div>

              {/* Account list */}
              {accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No accounts configured. Add your own and competitor accounts
                  above.
                </p>
              ) : (
                <div className="space-y-1">
                  {accounts.map((account) => (
                    <div
                      key={account.username}
                      className="flex items-center justify-between rounded-md border px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <a
                          href={`https://x.com/${account.username}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium hover:underline flex items-center gap-1"
                        >
                          @{account.username}
                          <ExternalLink className="h-3 w-3 text-muted-foreground" />
                        </a>
                        {account.oauthConnected ? (
                          <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 text-[10px] px-1.5 py-0">
                            OAuth Connected
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0"
                          >
                            No OAuth
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {!account.oauthConnected && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={connectingAccount === account.username}
                            onClick={() => connectOAuth(account.username)}
                          >
                            {connectingAccount === account.username ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Connect OAuth"
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => removeAccount(account.username)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Help text */}
              <p className="text-xs text-muted-foreground">
                Own accounts can connect OAuth for mentions tracking. Competitor
                accounts will track public tweets and engagement only. Polls run
                every 2 hours.
              </p>

              {/* Save button */}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={saveAccounts}
                  disabled={!dirty || saving}
                >
                  {saving ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="mr-1.5 h-3.5 w-3.5" />
                      Save Accounts
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
// Search Queries (Twitter / X)
// ---------------------------------------------------------------------------

function SearchQueriesSection({ source }: { source: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [queries, setQueries] = useState<string[]>([]);
  const [newQuery, setNewQuery] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadQueries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<TwitterSearchQueriesResponse>(
        `connections/${source}/search-queries`,
      );
      if (data.ok) {
        setQueries(data.queries);
      } else {
        setError(data.error ?? "Failed to load search queries");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load search queries",
      );
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [source]);

  useEffect(() => {
    if (expanded && !loaded && !loading) {
      loadQueries();
    }
  }, [expanded, loaded, loading, loadQueries]);

  const addQuery = () => {
    const cleaned = newQuery.trim();
    if (!cleaned) return;
    if (queries.includes(cleaned)) return;
    setQueries((prev) => [...prev, cleaned]);
    setNewQuery("");
    setDirty(true);
  };

  const removeQuery = (query: string) => {
    setQueries((prev) => prev.filter((q) => q !== query));
    setDirty(true);
  };

  const saveQueries = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put(`connections/${source}/search-queries`, { queries });
      setDirty(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save search queries",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <Search className="h-4 w-4 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Search Queries</CardTitle>
            <CardDescription>
              {queries.length > 0
                ? `${queries.length} search quer${queries.length === 1 ? "y" : "ies"} active`
                : "Add search queries to monitor keywords, hashtags, and competitors"}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                Loading queries...
              </span>
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <>
              {/* Add query input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newQuery}
                  onChange={(e) => setNewQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addQuery();
                  }}
                  placeholder='#hashtag, "exact phrase", from:username'
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
                />
                <Button
                  size="sm"
                  onClick={addQuery}
                  disabled={!newQuery.trim()}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </div>

              {/* Query list */}
              {queries.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No search queries configured. Add queries to monitor
                  keywords, hashtags, and competitor mentions.
                </p>
              ) : (
                <div className="space-y-1">
                  {queries.map((query) => (
                    <div
                      key={query}
                      className="flex items-center justify-between rounded-md border px-3 py-2"
                    >
                      <code className="text-sm bg-muted px-1.5 py-0.5 rounded">
                        {query}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => removeQuery(query)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Help text */}
              <p className="text-xs text-muted-foreground">
                Use X search syntax:{" "}
                <code className="bg-muted px-1 rounded">#hashtag</code>,{" "}
                <code className="bg-muted px-1 rounded">
                  &quot;exact phrase&quot;
                </code>
                ,{" "}
                <code className="bg-muted px-1 rounded">from:username</code>,{" "}
                <code className="bg-muted px-1 rounded">to:username</code>,{" "}
                <code className="bg-muted px-1 rounded">-excludeword</code>.
                Queries run every 2 hours.
              </p>

              {/* Save button */}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={saveQueries}
                  disabled={!dirty || saving}
                >
                  {saving ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="mr-1.5 h-3.5 w-3.5" />
                      Save Queries
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

      {/* Channel Picker (Discord only) */}
      {source === "discord" && adminSecretConfigured && (
        <ChannelPickerSection source={source} />
      )}

      {/* Webhook Topics (Intercom only) */}
      {source === "intercom" && adminSecretConfigured && (
        <WebhookTopicsSection source={source} />
      )}

      {/* Monitored Accounts (Twitter only) */}
      {source === "twitter" && adminSecretConfigured && (
        <MonitoredAccountsSection source={source} />
      )}

      {/* Search Queries (Twitter only) */}
      {source === "twitter" && adminSecretConfigured && (
        <SearchQueriesSection source={source} />
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
