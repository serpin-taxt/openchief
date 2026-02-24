import { useEffect, useState, useCallback } from "react";
import {
  Plus,
  Loader2,
  CheckCircle2,
  Clock,
  CircleDot,
  XCircle,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Sparkles,
  ListTodo,
} from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { cn, formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: "proposed" | "queued" | "in_progress" | "completed" | "cancelled";
  priority: number;
  createdBy: string;
  assignedTo: string | null;
  sourceReportId: string | null;
  output: { summary: string; content: string; artifacts: { name: string; type: string; content: string }[] } | null;
  context: { reasoning: string; relevantUrls?: string[] } | null;
  startedAt: string | null;
  completedAt: string | null;
  dueBy: string | null;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
}

interface TaskStat {
  status: string;
  count: number;
}

interface AgentOption {
  id: string;
  name: string;
}

type StatusFilter = "all" | "proposed" | "queued" | "in_progress" | "completed" | "cancelled";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "proposed", label: "Proposed" },
  { value: "queued", label: "Queued" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

function statusIcon(status: string) {
  switch (status) {
    case "proposed":
      return <Sparkles className="h-3.5 w-3.5 text-amber-500" />;
    case "queued":
      return <Clock className="h-3.5 w-3.5 text-blue-500" />;
    case "in_progress":
      return <CircleDot className="h-3.5 w-3.5 text-purple-500" />;
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
    case "cancelled":
      return <XCircle className="h-3.5 w-3.5 text-zinc-400" />;
    default:
      return null;
  }
}

function statusLabel(status: string): string {
  return status.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function priorityColor(p: number): string {
  if (p >= 80) return "bg-red-500/15 text-red-400 border-red-500/20";
  if (p >= 60) return "bg-orange-500/15 text-orange-400 border-orange-500/20";
  if (p >= 40) return "bg-yellow-500/15 text-yellow-400 border-yellow-500/20";
  return "bg-zinc-500/15 text-zinc-400 border-zinc-500/20";
}

function agentLabel(id: string | null, agents: AgentOption[]): string {
  if (!id) return "—";
  if (id.startsWith("user:")) return id.replace("user:", "");
  const agent = agents.find((a) => a.id === id);
  return agent?.name || id;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Tasks() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<TaskStat[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Set<string>>(new Set());

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [newPriority, setNewPriority] = useState(50);
  const [creating, setCreating] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [taskData, statData, agentData] = await Promise.all([
        api.get<TaskItem[]>(`tasks${filter !== "all" ? `?status=${filter}` : ""}`),
        api.get<TaskStat[]>("tasks/stats"),
        api.get<AgentOption[]>("agents"),
      ]);
      setTasks(taskData);
      setStats(statData);
      setAgents(agentData.map((a) => ({ id: a.id, name: a.name })));
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function updateTask(taskId: string, update: Record<string, unknown>) {
    setUpdating((prev) => new Set(prev).add(taskId));
    try {
      await api.put(`tasks/${taskId}`, update);
      await loadData();
    } catch (err) {
      console.error("Failed to update task:", err);
    } finally {
      setUpdating((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }

  async function createTask() {
    if (!newTitle.trim() || !newDesc.trim()) return;
    setCreating(true);
    try {
      await api.post("tasks", {
        title: newTitle.trim(),
        description: newDesc.trim(),
        assignedTo: newAssignee || undefined,
        priority: newPriority,
      });
      setCreateOpen(false);
      setNewTitle("");
      setNewDesc("");
      setNewAssignee("");
      setNewPriority(50);
      await loadData();
    } catch (err) {
      console.error("Failed to create task:", err);
    } finally {
      setCreating(false);
    }
  }

  function statCount(status: string): number {
    return stats.find((s) => s.status === status)?.count ?? 0;
  }

  const totalActive =
    statCount("proposed") + statCount("queued") + statCount("in_progress");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Agent-proposed work items — prioritized by the CEO, executed
            autonomously
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Create Task
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Task</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Write a blog post about..."
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Detailed description of what needs to be done..."
                  rows={4}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Assign To</Label>
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                    value={newAssignee}
                    onChange={(e) => setNewAssignee(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>Priority (0-100)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={newPriority}
                    onChange={(e) => setNewPriority(Number(e.target.value))}
                  />
                </div>
              </div>
              <Button
                className="w-full"
                onClick={createTask}
                disabled={creating || !newTitle.trim() || !newDesc.trim()}
              >
                {creating ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                )}
                Create
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats Summary */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span>
          {totalActive} active
        </span>
        <span className="text-zinc-700">•</span>
        <span>{statCount("proposed")} proposed</span>
        <span className="text-zinc-700">•</span>
        <span>{statCount("queued")} queued</span>
        <span className="text-zinc-700">•</span>
        <span>{statCount("in_progress")} in progress</span>
        <span className="text-zinc-700">•</span>
        <span>{statCount("completed")} completed</span>
      </div>

      {/* Status Tabs */}
      <div className="flex gap-1 rounded-lg border p-1 w-fit">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              filter === tab.value
                ? "bg-zinc-800 text-zinc-100"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.value !== "all" && statCount(tab.value) > 0 && (
              <span className="ml-1.5 text-xs opacity-60">
                {statCount(tab.value)}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tasks Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : tasks.length > 0 ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead className="w-16">
                  <ArrowUpDown className="inline h-3.5 w-3.5" /> Pri
                </TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Assigned To</TableHead>
                <TableHead>Created By</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => {
                const isExpanded = expandedId === task.id;
                const isUpdating = updating.has(task.id);

                return (
                  <>
                    <TableRow
                      key={task.id}
                      className={cn(
                        "cursor-pointer",
                        isExpanded && "border-b-0",
                        task.status === "cancelled" && "opacity-50",
                      )}
                      onClick={() =>
                        setExpandedId(isExpanded ? null : task.id)
                      }
                    >
                      <TableCell className="w-8 pr-0">
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn("text-xs tabular-nums", priorityColor(task.priority))}
                        >
                          {task.priority}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium max-w-xs truncate">
                        {task.title}
                      </TableCell>
                      <TableCell className="text-sm">
                        {task.assignedTo ? (
                          <Link
                            to={`/agents/${task.assignedTo}`}
                            className="hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {agentLabel(task.assignedTo, agents)}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {agentLabel(task.createdBy, agents)}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          {statusIcon(task.status)}
                          {statusLabel(task.status)}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(task.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div
                          className="flex items-center justify-end gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {task.status === "proposed" && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={isUpdating}
                                onClick={() =>
                                  updateTask(task.id, { status: "queued" })
                                }
                              >
                                Approve
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={isUpdating}
                                onClick={() =>
                                  updateTask(task.id, { status: "cancelled" })
                                }
                              >
                                <XCircle className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                          {task.status === "queued" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isUpdating}
                              onClick={() =>
                                updateTask(task.id, { status: "cancelled" })
                              }
                            >
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {task.status === "completed" && task.output && (
                            <Link to={`/tasks/${task.id}`}>
                              <Button variant="ghost" size="sm">
                                View
                              </Button>
                            </Link>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow key={`${task.id}-detail`}>
                        <TableCell colSpan={8} className="bg-zinc-950/50 px-8 py-4">
                          <div className="space-y-3 text-sm">
                            <div>
                              <div className="font-medium text-muted-foreground mb-1">
                                Description
                              </div>
                              <p className="text-foreground whitespace-pre-wrap">
                                {task.description}
                              </p>
                            </div>
                            {task.context?.reasoning && (
                              <div>
                                <div className="font-medium text-muted-foreground mb-1">
                                  Reasoning
                                </div>
                                <p className="text-foreground">
                                  {task.context.reasoning}
                                </p>
                              </div>
                            )}
                            {task.output && (
                              <div>
                                <div className="font-medium text-muted-foreground mb-1">
                                  Output Summary
                                </div>
                                <p className="text-foreground">
                                  {task.output.summary}
                                </p>
                                <Link
                                  to={`/tasks/${task.id}`}
                                  className="text-blue-400 hover:underline text-xs mt-1 inline-block"
                                >
                                  View full output →
                                </Link>
                              </div>
                            )}
                            {task.sourceReportId && (
                              <div className="text-xs text-muted-foreground">
                                Source report: {task.sourceReportId}
                              </div>
                            )}
                            {task.tokensUsed > 0 && (
                              <div className="text-xs text-muted-foreground">
                                Tokens used: {task.tokensUsed.toLocaleString()}
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="py-16 text-center">
          <ListTodo className="mx-auto h-10 w-10 text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">
            {filter === "all"
              ? "No tasks yet. Agents will propose tasks during their daily reports."
              : `No ${filter.replace("_", " ")} tasks.`}
          </p>
        </div>
      )}
    </div>
  );
}
