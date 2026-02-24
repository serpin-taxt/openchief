import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import {
  History,
  Pencil,
  Check,
  X,
  Plus,
  Trash2,
  ChevronRight,
  Upload,
  UserCircle,
  Mic,
  Sparkles,
  Paintbrush,
  Eye,
  Plug,
  FileText,
  ScrollText,
  TrendingUp,
  Activity,
  Target,
  Compass,
  Heart,
  Flag,
} from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
} from "recharts";
import type {
  AgentDefinition,
  AgentReport,
  AgentStrategy,
  EventSubscription,
  ReportConfig,
} from "@openchief/shared";
import { toast } from "sonner";
import { api, type EventVolumeBucket } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { HealthBadge } from "@/components/HealthBadge";
import { SourceIcon } from "@/components/SourceIcon";

/* ------------------------------------------------------------------ */
/*  Config card definitions                                            */
/* ------------------------------------------------------------------ */

type CardId =
  | "role"
  | "voice"
  | "personality"
  | "output-style"
  | "watch-patterns"
  | "sources"
  | "report-types"
  | "instructions"
  | "mission"
  | "vision"
  | "values"
  | "goals";

interface CardDef {
  id: CardId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  getSummary: (agent: AgentDefinition) => string;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max).trimEnd() + "...";
}

const CONFIG_CARDS: CardDef[] = [
  {
    id: "role",
    label: "Role",
    icon: UserCircle,
    getSummary: (a) => truncate(a.persona.role, 80),
  },
  {
    id: "voice",
    label: "Voice",
    icon: Mic,
    getSummary: (a) =>
      a.persona.voice ? truncate(a.persona.voice, 80) : "Not set",
  },
  {
    id: "personality",
    label: "Personality",
    icon: Sparkles,
    getSummary: (a) =>
      a.persona.personality
        ? truncate(a.persona.personality, 80)
        : "Not set",
  },
  {
    id: "output-style",
    label: "Output Style",
    icon: Paintbrush,
    getSummary: (a) => truncate(a.persona.outputStyle, 80),
  },
  {
    id: "watch-patterns",
    label: "Watch Patterns",
    icon: Eye,
    getSummary: (a) => {
      const count = a.persona.watchPatterns?.length ?? 0;
      return `${count} pattern${count !== 1 ? "s" : ""}`;
    },
  },
  {
    id: "sources",
    label: "Sources",
    icon: Plug,
    getSummary: (a) => {
      const subCount = a.subscriptions.length;
      const toolCount = a.tools?.length ?? 0;
      const parts = [
        `${subCount} subscription${subCount !== 1 ? "s" : ""}`,
      ];
      if (toolCount > 0)
        parts.push(`${toolCount} tool${toolCount !== 1 ? "s" : ""}`);
      return parts.join(", ");
    },
  },
  {
    id: "report-types",
    label: "Report Types",
    icon: FileText,
    getSummary: (a) => {
      const count = a.outputs?.reports?.length || 0;
      return `${count} type${count !== 1 ? "s" : ""}`;
    },
  },
  {
    id: "instructions",
    label: "Instructions",
    icon: ScrollText,
    getSummary: () => "View full instructions",
  },
];

const STRATEGY_CARDS: CardDef[] = [
  {
    id: "mission",
    label: "Mission",
    icon: Target,
    getSummary: (a) =>
      a.strategy?.mission ? truncate(a.strategy.mission, 80) : "Not set",
  },
  {
    id: "vision",
    label: "Vision",
    icon: Compass,
    getSummary: (a) =>
      a.strategy?.vision ? truncate(a.strategy.vision, 80) : "Not set",
  },
  {
    id: "values",
    label: "Values",
    icon: Heart,
    getSummary: (a) => {
      const count = a.strategy?.values?.length ?? 0;
      return count > 0
        ? `${count} value${count !== 1 ? "s" : ""}`
        : "Not set";
    },
  },
  {
    id: "goals",
    label: "Goals",
    icon: Flag,
    getSummary: (a) => {
      const count = a.strategy?.goals?.length ?? 0;
      return count > 0
        ? `${count} goal${count !== 1 ? "s" : ""}`
        : "Not set";
    },
  },
];

/* ------------------------------------------------------------------ */
/*  Chart helpers                                                      */
/* ------------------------------------------------------------------ */

/** Build unique date labels for chart X-axis from report timestamps.
 *  When multiple reports share the same day, appends the time to disambiguate. */
function buildDateLabels(reports: AgentReport[]): string[] {
  const raw = reports.map((r) =>
    new Date(r.createdAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
  );
  // Count occurrences
  const counts: Record<string, number> = {};
  for (const d of raw) counts[d] = (counts[d] || 0) + 1;
  // If any duplicate, append time for ALL entries to keep consistent formatting
  const hasDupes = Object.values(counts).some((c) => c > 1);
  if (!hasDupes) return raw;
  return reports.map((r) => {
    const d = new Date(r.createdAt);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  });
}

const SIGNAL_VALUE: Record<string, number> = {
  green: 3,
  yellow: 2,
  red: 1,
};

const healthChartConfig = {
  health: { label: "Health", color: "var(--chart-1)" },
} satisfies ChartConfig;

const SOURCE_COLORS: Record<string, string> = {
  github: "#34d399",
  slack: "#fbbf24",
  discord: "#818cf8",
  intercom: "#f472b6",
  jira: "#60a5fa",
  "jira-product-discovery": "#a78bfa",
  twitter: "#38bdf8",
  figma: "#fb923c",
  stripe: "#c084fc",
  amplitude: "#2dd4bf",
  "google-calendar": "#f97316",
  "google-analytics": "#4ade80",
  quickbooks: "#22d3ee",
  rippling: "#e879f9",
  notion: "#a3a3a3",
};

function getSourceColor(source: string): string {
  return SOURCE_COLORS[source] || "var(--chart-3)";
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentDefinition | null>(null);
  const [reports, setReports] = useState<AgentReport[]>([]);
  const [volumeData, setVolumeData] = useState<EventVolumeBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [openDrawer, setOpenDrawer] = useState<CardId | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasAvatar = !!avatarUrl;

  const handleAvatarUpload = useCallback(
    async (file: File) => {
      if (!id) return;
      const toastId = toast.loading("Uploading avatar...");
      try {
        const res = await fetch(`/api/agents/${id}/avatar`, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        setAvatarUrl(`/api/agents/${id}/avatar?v=${Date.now()}`);
        toast.success("Avatar uploaded", { id: toastId });
      } catch (err) {
        console.error("Avatar upload failed:", err);
        toast.error("Avatar upload failed", { id: toastId });
      }
    },
    [id],
  );

  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      const agentData = await api.get<AgentDefinition & { avatarUrl?: string | null }>(`agents/${id}`);
      setAgent(agentData);
      setAvatarUrl(agentData.avatarUrl ?? null);

      const [reportList, volume] = await Promise.allSettled([
        api.get<AgentReport[]>(`agents/${id}/reports`),
        api.get<EventVolumeBucket[]>(`agents/${id}/events/volume`),
      ]);
      if (reportList.status === "fulfilled") setReports(reportList.value);
      if (volume.status === "fulfilled") setVolumeData(volume.value);
    } catch (err) {
      console.error("Failed to load agent:", err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /** Persist updated agent config to the API */
  const saveAgent = useCallback(
    async (updated: AgentDefinition) => {
      if (!id) return;
      await api.put(`agents/${id}`, updated);
      setAgent(updated);
    },
    [id],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        Agent not found.
      </div>
    );
  }

  return (
    <div className="relative space-y-6">
      {/* Avatar background image — breaks out of max-w container to span full viewport */}
      {hasAvatar && (
        <div className="absolute -top-6 left-1/2 -translate-x-1/2 w-screen h-[512px] overflow-hidden pointer-events-none">
          <img
            src={avatarUrl}
            alt=""
            className="h-full w-full object-cover object-top opacity-50 grayscale"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background from-15% via-background/80 via-55% to-background/30" />
        </div>
      )}

      {/* Page Header */}
      <div className="relative">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <Link to="/" className="hover:text-foreground">
            Dashboard
          </Link>
          <ChevronRight className="h-3 w-3" />
          <span>{agent.name}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {agent.name}
        </h1>
        <p className="mt-1 text-muted-foreground">{agent.description}</p>
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-border bg-card"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Avatar
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleAvatarUpload(file);
              e.target.value = "";
            }}
          />
          <Link to={`/modules/${id}/history`}>
            <Button variant="outline" size="sm" className="border-border bg-card">
              <History className="mr-1.5 h-3.5 w-3.5" />
              History
            </Button>
          </Link>
        </div>
      </div>

      {/* Latest Report */}
      {reports.length > 0 && (() => {
        const latest = reports[0];
        const signal = latest.content?.healthSignal ?? null;
        const borderClass = signal === "green" ? "hover:border-emerald-500/60" : signal === "yellow" ? "hover:border-amber-500/60" : signal === "red" ? "hover:border-red-500/60" : "";
        const bgClass = signal === "green" ? "hover:bg-emerald-500/[0.08]" : signal === "yellow" ? "hover:bg-amber-500/[0.08]" : signal === "red" ? "hover:bg-red-500/[0.08]" : "";
        const dotClass = signal === "green" ? "bg-emerald-500" : signal === "yellow" ? "bg-amber-500" : signal === "red" ? "bg-red-500" : "bg-muted-foreground/30";
        return (
          <section className="relative">
            <h2 className="mb-3 text-lg font-medium">Latest Report</h2>
            <Link to={`/modules/${id}/reports/${latest.id}`}>
              <div className={cn("flex items-start gap-3 rounded-lg border border-border p-4 transition-all", borderClass, bgClass)}>
                <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", dotClass)} />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm leading-snug font-medium">
                    {latest.content?.headline ?? "Untitled report"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDate(latest.createdAt)} &middot; {latest.reportType}
                  </p>
                </div>
              </div>
            </Link>
          </section>
        );
      })()}

      {/* Charts Grid */}
      {reports.length > 0 && (
        <section className="relative">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <HealthTrendChart reports={reports} />
            <EventVolumeChart data={volumeData} />
            <ActionItemsChart reports={reports} />
            <SeverityBreakdownChart reports={reports} />
          </div>
        </section>
      )}

      {/* Config Cards Grid */}
      <section className="relative">
        <h2 className="mb-3 text-lg font-medium">Configuration</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {CONFIG_CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.id}
                onClick={() => setOpenDrawer(card.id)}
                className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-left transition-colors hover:border-ring hover:bg-secondary/50"
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {card.label}
                  </span>
                </div>
                <p className="text-sm leading-snug text-foreground/80 line-clamp-2">
                  {card.getSummary(agent)}
                </p>
              </button>
            );
          })}
        </div>
      </section>

      {/* Strategy Cards — only for agents with strategy config (CEO) */}
      {agent.strategy && (
        <section className="relative">
          <h2 className="mb-3 text-lg font-medium">Strategy</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {STRATEGY_CARDS.map((card) => {
              const Icon = card.icon;
              return (
                <button
                  key={card.id}
                  onClick={() => setOpenDrawer(card.id)}
                  className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-left transition-colors hover:border-ring hover:bg-secondary/50"
                >
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {card.label}
                    </span>
                  </div>
                  <p className="text-sm leading-snug text-foreground/80 line-clamp-2">
                    {card.getSummary(agent)}
                  </p>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Per-section Drawers */}
      <Sheet
        open={openDrawer === "role"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Role</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditablePersonaField
              label="Role"
              placeholder="The role identity for this agent — who they are, what they oversee..."
              value={agent.persona.role}
              onSave={async (value) => {
                await saveAgent({
                  ...agent,
                  persona: { ...agent.persona, role: value },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={openDrawer === "voice"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Voice</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditablePersonaField
              label="Voice"
              placeholder="How this agent speaks — vocabulary, cadence, verbal habits, catchphrases..."
              value={agent.persona.voice}
              onSave={async (value) => {
                await saveAgent({
                  ...agent,
                  persona: {
                    ...agent.persona,
                    voice: value || undefined,
                  },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={openDrawer === "personality"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Personality</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditablePersonaField
              label="Personality"
              placeholder="Who this agent is — temperament, values, quirks, communication style..."
              value={agent.persona.personality}
              onSave={async (value) => {
                await saveAgent({
                  ...agent,
                  persona: {
                    ...agent.persona,
                    personality: value || undefined,
                  },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={openDrawer === "output-style"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Output Style</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditablePersonaField
              label="Output Style"
              placeholder="How reports should be structured — tone, format, length, style preferences..."
              value={agent.persona.outputStyle}
              onSave={async (value) => {
                await saveAgent({
                  ...agent,
                  persona: { ...agent.persona, outputStyle: value },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={openDrawer === "watch-patterns"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Watch Patterns</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditableListField
              label="Watch Patterns"
              placeholder="Add a pattern to watch for..."
              items={agent.persona.watchPatterns ?? []}
              onSave={async (items) => {
                await saveAgent({
                  ...agent,
                  persona: { ...agent.persona, watchPatterns: items },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={openDrawer === "sources"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Sources &amp; Tools</SheetTitle>
          </SheetHeader>
          <div className="space-y-6 px-4 pb-6">
            <EditableSubscriptions
              subscriptions={agent.subscriptions}
              onSave={async (subs) => {
                await saveAgent({ ...agent, subscriptions: subs });
              }}
            />
            {agent.tools && agent.tools.length > 0 && (
              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Tools
                </span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {agent.tools.map((tool) => (
                    <Badge key={tool} variant="secondary" className="gap-1.5">
                      {tool}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={openDrawer === "report-types"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Report Types</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditableReportTypes
              reports={agent.outputs?.reports || []}
              onSave={async (rpts) => {
                await saveAgent({
                  ...agent,
                  outputs: { ...agent.outputs, reports: rpts },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={openDrawer === "instructions"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Instructions</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditablePersonaField
              label="Instructions"
              placeholder="Detailed instructions for how this agent should analyze data and produce reports..."
              value={agent.persona.instructions}
              onSave={async (value) => {
                await saveAgent({
                  ...agent,
                  persona: { ...agent.persona, instructions: value },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Strategy Drawers */}
      <Sheet
        open={openDrawer === "mission"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Mission</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditablePersonaField
              label="Mission"
              placeholder="Why your company exists — the core purpose that drives everything..."
              value={agent.strategy?.mission}
              onSave={async (value) => {
                await saveAgent({
                  ...agent,
                  strategy: {
                    ...agent.strategy,
                    mission: value || undefined,
                  },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={openDrawer === "vision"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Vision</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditablePersonaField
              label="Vision"
              placeholder="Where your company is headed — the future state you're building toward..."
              value={agent.strategy?.vision}
              onSave={async (value) => {
                await saveAgent({
                  ...agent,
                  strategy: {
                    ...agent.strategy,
                    vision: value || undefined,
                  },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={openDrawer === "values"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Values</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditableListField
              label="Values"
              placeholder="Add a core value..."
              items={agent.strategy?.values ?? []}
              onSave={async (items) => {
                await saveAgent({
                  ...agent,
                  strategy: {
                    ...agent.strategy,
                    values: items.length > 0 ? items : undefined,
                  },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={openDrawer === "goals"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-full sm:w-[500px] sm:max-w-[600px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Goals</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">
            <EditableListField
              label="Strategic Goals"
              placeholder="Add a strategic goal..."
              items={agent.strategy?.goals ?? []}
              onSave={async (items) => {
                await saveAgent({
                  ...agent,
                  strategy: {
                    ...agent.strategy,
                    goals: items.length > 0 ? items : undefined,
                  },
                });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Past Reports */}
      <section>
        <h2 className="mb-3 text-lg font-medium">Past Reports</h2>
        {reports.length > 0 ? (
          <>
            {/* Mobile: card list */}
            <div className="space-y-2 sm:hidden">
              {reports.map((report) => {
                const signal = report.content?.healthSignal ?? "green";
                const dotClass = signal === "green" ? "bg-emerald-500" : signal === "yellow" ? "bg-amber-500" : signal === "red" ? "bg-red-500" : "bg-muted-foreground/30";
                return (
                  <Link
                    key={report.id}
                    to={`/modules/${id}/reports/${report.id}`}
                    className="block rounded-lg border border-border p-3 transition-colors hover:bg-secondary/50"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", dotClass)} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-snug line-clamp-2">
                          {report.content?.headline ?? "Untitled report"}
                        </p>
                        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {report.reportType}
                          </Badge>
                          <span>{formatDate(report.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
            {/* Desktop: table */}
            <div className="hidden sm:block rounded-lg border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Report Type</TableHead>
                    <TableHead>Health</TableHead>
                    <TableHead>Headline</TableHead>
                    <TableHead className="text-right">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reports.map((report) => (
                    <TableRow key={report.id}>
                      <TableCell>
                        <Badge variant="outline">{report.reportType}</Badge>
                      </TableCell>
                      <TableCell>
                        <HealthBadge
                          signal={report.content?.healthSignal ?? "green"}
                        />
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/modules/${id}/reports/${report.id}`}
                          className="font-medium hover:underline"
                        >
                          {report.content?.headline ?? "Untitled report"}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatDate(report.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No reports generated yet.
          </p>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  HealthTrendChart                                                   */
/* ------------------------------------------------------------------ */

function HealthTrendChart({ reports }: { reports: AgentReport[] }) {
  const data = useMemo(() => {
    const filtered = reports
      .filter((r) => r.content?.healthSignal)
      .slice(0, 14)
      .reverse();
    const labels = buildDateLabels(filtered);
    return filtered.map((r, i) => ({
      id: r.id,
      date: labels[i],
      health: SIGNAL_VALUE[r.content.healthSignal] || 3,
      signal: r.content.healthSignal,
    }));
  }, [reports]);

  const trend = useMemo(() => {
    if (data.length < 2) return null;
    const recent = data.slice(-3);
    const earlier = data.slice(0, 3);
    const recentAvg = recent.reduce((s, d) => s + d.health, 0) / recent.length;
    const earlierAvg =
      earlier.reduce((s, d) => s + d.health, 0) / earlier.length;
    const diff = recentAvg - earlierAvg;
    if (Math.abs(diff) < 0.1) return null;
    return diff > 0 ? "up" : "down";
  }, [data]);

  const latestSignal =
    data.length > 0 ? data[data.length - 1].signal : "green";

  return (
    <Card className="flex flex-col gap-0 py-3">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm">Health Trend</CardTitle>
        <CardDescription className="text-xs">
          Last {data.length} reports
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pb-0">
        {data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground/40">
            <Activity className="h-8 w-8" />
            <span className="text-xs font-medium">No reports yet</span>
          </div>
        ) : (
          <ChartContainer
            config={healthChartConfig}
            className="aspect-auto h-[120px] w-full"
          >
            <LineChart
              accessibilityLayer
              data={data}
              margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value) => value.slice(0, 3)}
                tick={{ fontSize: 10 }}
              />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent hideLabel />}
              />
              <Line
                dataKey="health"
                type="linear"
                stroke={
                  latestSignal === "green"
                    ? "#34d399"
                    : latestSignal === "yellow"
                      ? "#fbbf24"
                      : "#f87171"
                }
                strokeWidth={2}
                dot={{ r: data.length <= 3 ? 4 : 0, fill: latestSignal === "green" ? "#34d399" : latestSignal === "yellow" ? "#fbbf24" : "#f87171" }}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="pt-1 pb-0 px-4">
        {trend ? (
          <div className="flex gap-2 text-xs leading-none font-medium">
            {trend === "up" ? "Trending healthier" : "Declining health"}
            <TrendingUp
              className={`h-3 w-3 ${trend === "down" ? "rotate-180" : ""}`}
            />
          </div>
        ) : (
          <div className="text-xs text-muted-foreground leading-none">
            {data.length === 1 ? "1 report so far" : "Stable health signal"}
          </div>
        )}
      </CardFooter>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  EventVolumeChart                                                   */
/* ------------------------------------------------------------------ */

function EventVolumeChart({ data }: { data: EventVolumeBucket[] }) {
  const { sources, chartData, totalEvents } = useMemo(() => {
    if (data.length === 0)
      return {
        sources: [] as string[],
        chartData: [] as Record<string, unknown>[],
        totalEvents: 0,
      };

    const srcSet = new Set(data.map((d) => d.source));
    const sources = [...srcSet].sort();

    const byDate: Record<string, Record<string, number>> = {};
    let totalEvents = 0;
    for (const row of data) {
      if (!byDate[row.date]) byDate[row.date] = {};
      byDate[row.date][row.source] = row.count;
      totalEvents += row.count;
    }

    const chartData: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      const entry: Record<string, unknown> = { date: label };
      for (const src of sources) {
        entry[src] = byDate[key]?.[src] || 0;
      }
      chartData.push(entry);
    }

    return { sources, chartData, totalEvents };
  }, [data]);

  const chartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const src of sources) {
      cfg[src] = {
        label: src.charAt(0).toUpperCase() + src.slice(1),
        color: getSourceColor(src),
      };
    }
    return cfg;
  }, [sources]);

  return (
    <Card className="flex flex-col gap-0 py-3">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm">Event Volume</CardTitle>
        <CardDescription className="text-xs">
          Last 30 days by source
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pb-0">
        {sources.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground/40">
            <Activity className="h-8 w-8" />
            <span className="text-xs font-medium">No events yet</span>
          </div>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-[120px] w-full"
          >
            <BarChart
              accessibilityLayer
              data={chartData}
              margin={{ left: 0, right: 4, top: 8, bottom: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(v) => v.slice(0, 3)}
                tick={{ fontSize: 10 }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              {sources.map((src, i) => (
                <Bar
                  key={src}
                  dataKey={src}
                  stackId="a"
                  fill={getSourceColor(src)}
                  radius={
                    i === sources.length - 1
                      ? [2, 2, 0, 0]
                      : [0, 0, 0, 0]
                  }
                />
              ))}
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="pt-1 pb-0 px-4">
        <div className="text-xs text-muted-foreground leading-none">
          {totalEvents > 0
            ? `${totalEvents.toLocaleString()} events from ${sources.length} source${sources.length === 1 ? "" : "s"}`
            : "Waiting for events"}
        </div>
      </CardFooter>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  ActionItemsChart                                                   */
/* ------------------------------------------------------------------ */

const actionItemsChartConfig = {
  low: { label: "Low", color: "var(--color-muted-foreground)" },
  medium: { label: "Medium", color: "#34d399" },
  high: { label: "High", color: "#fbbf24" },
  critical: { label: "Critical", color: "#f87171" },
} satisfies ChartConfig;

const PRIORITY_COLORS: Record<string, string> = {
  low: "#a3a3a3",
  medium: "#34d399",
  high: "#fbbf24",
  critical: "#f87171",
};

function ActionItemsChart({ reports }: { reports: AgentReport[] }) {
  const { data, totalItems, trend } = useMemo(() => {
    const filtered = reports
      .filter((r) => r.content?.actionItems)
      .slice(0, 14)
      .reverse();
    const labels = buildDateLabels(filtered);
    const data = filtered.map((r, i) => {
      const items = r.content.actionItems || [];
      const counts: Record<string, number> = {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      };
      for (const item of items) {
        counts[item.priority] = (counts[item.priority] || 0) + 1;
      }
      return {
        date: labels[i],
        ...counts,
        total: items.length,
      };
    });

    const totalItems = data.reduce((s, d) => s + d.total, 0);

    let trend: "up" | "down" | null = null;
    if (data.length >= 4) {
      const recentAvg =
        data.slice(-3).reduce((s, d) => s + d.total, 0) / 3;
      const earlierAvg =
        data.slice(0, 3).reduce((s, d) => s + d.total, 0) / 3;
      const diff = recentAvg - earlierAvg;
      if (Math.abs(diff) >= 0.5) trend = diff > 0 ? "up" : "down";
    }

    return { data, totalItems, trend };
  }, [reports]);

  return (
    <Card className="flex flex-col gap-0 py-3">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm">Action Items</CardTitle>
        <CardDescription className="text-xs">
          By priority per report
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pb-0">
        {data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground/40">
            <Activity className="h-8 w-8" />
            <span className="text-xs font-medium">No reports yet</span>
          </div>
        ) : (
          <ChartContainer
            config={actionItemsChartConfig}
            className="aspect-auto h-[120px] w-full"
          >
            <BarChart
              accessibilityLayer
              data={data}
              margin={{ left: 0, right: 4, top: 8, bottom: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(v) => v.slice(0, 3)}
                tick={{ fontSize: 10 }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              {(["low", "medium", "high", "critical"] as const).map(
                (priority, i) => (
                  <Bar
                    key={priority}
                    dataKey={priority}
                    stackId="a"
                    fill={PRIORITY_COLORS[priority]}
                    radius={i === 3 ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                  />
                ),
              )}
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="pt-1 pb-0 px-4">
        {trend ? (
          <div className="flex gap-2 text-xs leading-none font-medium">
            {trend === "up" ? "More items recently" : "Fewer items recently"}
            <TrendingUp
              className={`h-3 w-3 ${trend === "down" ? "rotate-180" : ""}`}
            />
          </div>
        ) : (
          <div className="text-xs text-muted-foreground leading-none">
            {totalItems > 0
              ? `${totalItems} items across ${data.length} reports`
              : "No action items yet"}
          </div>
        )}
      </CardFooter>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  SeverityBreakdownChart                                             */
/* ------------------------------------------------------------------ */

const SEVERITY_COLORS: Record<string, string> = {
  info: "#60a5fa",
  warning: "#fbbf24",
  critical: "#f87171",
};

const severityChartConfig = {
  info: { label: "Info", color: "#60a5fa" },
  warning: { label: "Warning", color: "#fbbf24" },
  critical: { label: "Critical", color: "#f87171" },
} satisfies ChartConfig;

function SeverityBreakdownChart({ reports }: { reports: AgentReport[] }) {
  const { data, dominant } = useMemo(() => {
    const filtered = reports
      .filter((r) => r.content?.sections?.length)
      .slice(0, 14)
      .reverse();
    const labels = buildDateLabels(filtered);
    const data = filtered.map((r, i) => {
      const counts: Record<string, number> = {
        info: 0,
        warning: 0,
        critical: 0,
      };
      for (const section of r.content.sections) {
        counts[section.severity] = (counts[section.severity] || 0) + 1;
      }
      return {
        date: labels[i],
        ...counts,
      };
    });

    // Find dominant severity across all reports
    const totals = { info: 0, warning: 0, critical: 0 };
    for (const d of data) {
      totals.info += d.info;
      totals.warning += d.warning;
      totals.critical += d.critical;
    }
    const total = totals.info + totals.warning + totals.critical;
    let dominant: string | null = null;
    if (total > 0) {
      if (totals.critical / total > 0.3) dominant = "Mostly critical";
      else if (totals.warning / total > 0.4) dominant = "Elevated warnings";
      else dominant = "Mostly stable";
    }

    return { data, dominant };
  }, [reports]);

  return (
    <Card className="flex flex-col gap-0 py-3">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm">Section Severity</CardTitle>
        <CardDescription className="text-xs">
          Report sections by severity
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pb-0">
        {data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground/40">
            <Activity className="h-8 w-8" />
            <span className="text-xs font-medium">No reports yet</span>
          </div>
        ) : (
          <ChartContainer
            config={severityChartConfig}
            className="aspect-auto h-[120px] w-full"
          >
            <BarChart
              accessibilityLayer
              data={data}
              margin={{ left: 0, right: 4, top: 8, bottom: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(v) => v.slice(0, 3)}
                tick={{ fontSize: 10 }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              {(["info", "warning", "critical"] as const).map(
                (severity, i) => (
                  <Bar
                    key={severity}
                    dataKey={severity}
                    stackId="a"
                    fill={SEVERITY_COLORS[severity]}
                    radius={i === 2 ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                  />
                ),
              )}
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="pt-1 pb-0 px-4">
        <div className="text-xs text-muted-foreground leading-none">
          {dominant || "No section data yet"}
        </div>
      </CardFooter>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  EditablePersonaField                                               */
/* ------------------------------------------------------------------ */

function EditablePersonaField({
  label,
  placeholder,
  value,
  onSave,
}: {
  label: string;
  placeholder: string;
  value?: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.style.height = "auto";
      el.style.height = `${Math.max(el.scrollHeight, 100)}px`;
    }
  }, [editing, draft]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {!editing && (
          <button
            onClick={() => {
              setDraft(value || "");
              setEditing(true);
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed placeholder-muted-foreground outline-none transition-colors focus:border-ring"
          />
          <div className="flex gap-2">
            <button
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave(draft.trim());
                  setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-ring disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : value ? (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {value}
        </p>
      ) : (
        <p className="mt-1 text-sm italic text-muted-foreground/50">
          {placeholder}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  EditableListField — for watch patterns                             */
/* ------------------------------------------------------------------ */

function EditableListField({
  label,
  placeholder,
  items,
  onSave,
}: {
  label: string;
  placeholder: string;
  items: string[];
  onSave: (items: string[]) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(items);
  const [newItem, setNewItem] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const startEdit = () => {
    setDraft([...items]);
    setEditing(true);
    setEditingIndex(null);
    setNewItem("");
  };

  const addItem = () => {
    const trimmed = newItem.trim();
    if (!trimmed) return;
    setDraft([...draft, trimmed]);
    setNewItem("");
  };

  const removeItem = (index: number) => {
    setDraft(draft.filter((_, i) => i !== index));
  };

  const startEditItem = (index: number) => {
    setEditingIndex(index);
    setEditDraft(draft[index]);
  };

  const saveEditItem = () => {
    if (editingIndex === null) return;
    const trimmed = editDraft.trim();
    if (trimmed) {
      const updated = [...draft];
      updated[editingIndex] = trimmed;
      setDraft(updated);
    }
    setEditingIndex(null);
    setEditDraft("");
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {!editing && (
          <button
            onClick={startEdit}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <ul className="space-y-1.5">
            {draft.map((item, i) => (
              <li
                key={i}
                className="group flex items-start gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm"
              >
                {editingIndex === i ? (
                  <div className="flex-1 flex gap-1.5">
                    <input
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveEditItem()}
                      className="flex-1 bg-transparent text-sm outline-none"
                      autoFocus
                    />
                    <button
                      onClick={saveEditItem}
                      className="shrink-0 text-primary hover:text-primary/80"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setEditingIndex(null)}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    <span
                      className="flex-1 text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                      onClick={() => startEditItem(i)}
                    >
                      {item}
                    </span>
                    <button
                      onClick={() => removeItem(i)}
                      className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="flex gap-1.5">
            <input
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addItem()}
              placeholder={placeholder}
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm placeholder-muted-foreground outline-none transition-colors focus:border-ring"
            />
            <button
              onClick={addItem}
              disabled={!newItem.trim()}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground disabled:opacity-30"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave(draft);
                  setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-ring disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {items.map((p, i) => (
            <li
              key={i}
              className="flex items-start gap-2 text-sm text-muted-foreground"
            >
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              {p}
            </li>
          ))}
          {items.length === 0 && (
            <p className="text-sm italic text-muted-foreground/50">
              No watch patterns configured
            </p>
          )}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  EditableSubscriptions — for sources                                */
/* ------------------------------------------------------------------ */

function EditableSubscriptions({
  subscriptions,
  onSave,
}: {
  subscriptions: EventSubscription[];
  onSave: (subs: EventSubscription[]) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EventSubscription[]>(subscriptions);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(
      subscriptions.map((s) => ({
        ...s,
        eventTypes: [...s.eventTypes],
      })),
    );
    setEditing(true);
  };

  const updateSub = (
    index: number,
    field: "source" | "eventTypes",
    value: string,
  ) => {
    const updated = [...draft];
    if (field === "source") {
      updated[index] = { ...updated[index], source: value };
    } else {
      updated[index] = {
        ...updated[index],
        eventTypes: value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }
    setDraft(updated);
  };

  const addSub = () => {
    setDraft([...draft, { source: "", eventTypes: ["*"] }]);
  };

  const removeSub = (index: number) => {
    setDraft(draft.filter((_, i) => i !== index));
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Subscriptions
        </span>
        {!editing && (
          <button
            onClick={startEdit}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          {draft.map((sub, i) => (
            <div
              key={i}
              className="group flex items-center gap-2 rounded-md border border-border p-2"
            >
              <div className="flex-1 space-y-1.5">
                <input
                  value={sub.source}
                  onChange={(e) => updateSub(i, "source", e.target.value)}
                  placeholder="Source (e.g. github, slack)"
                  className="w-full rounded border border-input bg-background px-2 py-1 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-ring"
                />
                <input
                  value={sub.eventTypes.join(", ")}
                  onChange={(e) => updateSub(i, "eventTypes", e.target.value)}
                  placeholder="Event types (comma-separated, e.g. pr.*, issue.*)"
                  className="w-full rounded border border-input bg-background px-2 py-1 text-sm placeholder-muted-foreground outline-none focus:border-ring"
                />
              </div>
              <button
                onClick={() => removeSub(i)}
                className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            onClick={addSub}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            Add subscription
          </button>
          <div className="flex gap-2 pt-1">
            <button
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave(draft.filter((s) => s.source.trim()));
                  setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-ring disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {subscriptions.map((sub, i) => (
            <Badge key={i} variant="secondary">
              {sub.source}: {sub.eventTypes.join(", ")}
            </Badge>
          ))}
          {subscriptions.length === 0 && (
            <p className="text-sm italic text-muted-foreground/50">
              No subscriptions configured
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  EditableReportTypes — for report configs                           */
/* ------------------------------------------------------------------ */

function EditableReportTypes({
  reports,
  onSave,
}: {
  reports: ReportConfig[];
  onSave: (reports: ReportConfig[]) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReportConfig[]>(reports);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(reports.map((r) => ({ ...r, sections: [...r.sections] })));
    setEditing(true);
  };

  const updateReport = (
    index: number,
    field: keyof ReportConfig,
    value: string,
  ) => {
    const updated = [...draft];
    if (field === "sections") {
      updated[index] = {
        ...updated[index],
        sections: value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    } else if (field === "cadence") {
      updated[index] = {
        ...updated[index],
        cadence: value as ReportConfig["cadence"],
      };
    } else {
      updated[index] = { ...updated[index], [field]: value };
    }
    setDraft(updated);
  };

  const addReport = () => {
    setDraft([...draft, { reportType: "", cadence: "daily", sections: [] }]);
  };

  const removeReport = (index: number) => {
    setDraft(draft.filter((_, i) => i !== index));
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Report Types
        </span>
        {!editing && (
          <button
            onClick={startEdit}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          {draft.map((r, i) => (
            <div
              key={i}
              className="group rounded-md border border-border p-3 space-y-2"
            >
              <div className="flex items-start justify-between">
                <input
                  value={r.reportType}
                  onChange={(e) =>
                    updateReport(i, "reportType", e.target.value)
                  }
                  placeholder="Report type (e.g. daily-standup)"
                  className="flex-1 rounded border border-input bg-background px-2 py-1 text-sm font-medium placeholder-muted-foreground outline-none focus:border-ring"
                />
                <button
                  onClick={() => removeReport(i)}
                  className="ml-2 shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="flex gap-2">
                <select
                  value={r.cadence}
                  onChange={(e) =>
                    updateReport(i, "cadence", e.target.value)
                  }
                  className="rounded border border-input bg-background px-2 py-1 text-sm outline-none focus:border-ring"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>
              <input
                value={r.sections.join(", ")}
                onChange={(e) =>
                  updateReport(i, "sections", e.target.value)
                }
                placeholder="Sections (comma-separated)"
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm placeholder-muted-foreground outline-none focus:border-ring"
              />
            </div>
          ))}
          <button
            onClick={addReport}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            Add report type
          </button>
          <div className="flex gap-2 pt-1">
            <button
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave(draft.filter((r) => r.reportType.trim()));
                  setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-ring disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {reports.map((r, i) => (
            <div key={i} className="rounded-md border border-border p-3">
              <p className="text-sm font-medium">{r.reportType}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {r.cadence} &middot; {r.sections.join(", ")}
              </p>
            </div>
          ))}
          {reports.length === 0 && (
            <p className="text-sm italic text-muted-foreground/50">
              No report types configured
            </p>
          )}
        </div>
      )}
    </div>
  );
}
