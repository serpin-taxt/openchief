import { useEffect, useState, useRef, useCallback } from "react";
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
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type {
  AgentDefinition,
  AgentReport,
  EventSubscription,
  ReportConfig,
} from "@openchief/shared";
import { toast } from "sonner";
import { api, type EventVolumeBucket } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
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
  | "instructions";

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

/* ------------------------------------------------------------------ */
/*  Chart helpers                                                      */
/* ------------------------------------------------------------------ */

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function buildChartData(
  buckets: EventVolumeBucket[],
): { date: string; [source: string]: string | number }[] {
  const byDate = new Map<string, Record<string, number>>();
  for (const b of buckets) {
    const rec = byDate.get(b.date) ?? {};
    rec[b.source] = (rec[b.source] ?? 0) + b.count;
    byDate.set(b.date, rec);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sources]) => ({ date, ...sources }));
}

function uniqueSources(buckets: EventVolumeBucket[]): string[] {
  return [...new Set(buckets.map((b) => b.source))];
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
  const [hasAvatar, setHasAvatar] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const avatarUrl = id ? `/api/agents/${id}/avatar?v=${avatarVersion}` : "";

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
        setAvatarVersion((v) => v + 1);
        setHasAvatar(true);
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
      setHasAvatar(!!agentData.avatarUrl);

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

  const chartData = buildChartData(volumeData);
  const sources = uniqueSources(volumeData);

  return (
    <div className="relative space-y-6">
      {/* Avatar background image */}
      {hasAvatar && (
        <div className="absolute -top-6 -left-6 -right-6 h-[512px] overflow-hidden pointer-events-none">
          <img
            src={avatarUrl}
            alt=""
            className="h-full w-full object-cover object-top opacity-40"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background from-5% via-background/70 via-50% to-transparent" />
        </div>
      )}

      {/* Page Header */}
      <div className="relative flex items-center justify-between">
        <div>
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
        </div>
        <div className="flex items-center gap-2">
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

      {/* Config Cards Grid */}
      <section className="relative">
        <h2 className="mb-3 text-lg font-medium">Configuration</h2>
        <div className="grid grid-cols-4 gap-3">
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

      {/* Per-section Drawers */}
      <Sheet
        open={openDrawer === "role"}
        onOpenChange={(open) => !open && setOpenDrawer(null)}
      >
        <SheetContent className="w-[500px] sm:max-w-[600px] overflow-y-auto">
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
        <SheetContent className="w-[500px] sm:max-w-[600px] overflow-y-auto">
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
        <SheetContent className="w-[500px] sm:max-w-[600px] overflow-y-auto">
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
        <SheetContent className="w-[500px] sm:max-w-[600px] overflow-y-auto">
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
        <SheetContent className="w-[500px] sm:max-w-[600px] overflow-y-auto">
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
        <SheetContent className="w-[500px] sm:max-w-[600px] overflow-y-auto">
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
        <SheetContent className="w-[500px] sm:max-w-[600px] overflow-y-auto">
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
        <SheetContent className="w-[500px] sm:max-w-[600px] overflow-y-auto">
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

      {/* Event Volume Chart */}
      {chartData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Event Volume</CardTitle>
            <CardDescription>
              Daily event volume by source (last 30 days)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <XAxis
                    dataKey="date"
                    tickFormatter={(d: string) =>
                      new Date(d).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })
                    }
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                    }}
                  />
                  <Legend />
                  {sources.map((source, i) => (
                    <Bar
                      key={source}
                      dataKey={source}
                      stackId="volume"
                      fill={CHART_COLORS[i % CHART_COLORS.length]}
                      radius={
                        i === sources.length - 1 ? [4, 4, 0, 0] : undefined
                      }
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Past Reports */}
      <section>
        <h2 className="mb-3 text-lg font-medium">Past Reports</h2>
        {reports.length > 0 ? (
          <div className="rounded-lg border border-border overflow-hidden">
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
