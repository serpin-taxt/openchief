import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  CircleDot,
  Sparkles,
  XCircle,
  FileText,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import ReactMarkdown from "react-markdown";

interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  createdBy: string;
  assignedTo: string | null;
  sourceReportId: string | null;
  output: {
    summary: string;
    content: string;
    artifacts: { name: string; type: string; content: string }[];
  } | null;
  context: { reasoning: string; relevantUrls?: string[] } | null;
  startedAt: string | null;
  completedAt: string | null;
  dueBy: string | null;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
}

function statusIcon(status: string) {
  switch (status) {
    case "proposed":
      return <Sparkles className="h-4 w-4 text-amber-500" />;
    case "queued":
      return <Clock className="h-4 w-4 text-blue-500" />;
    case "in_progress":
      return <CircleDot className="h-4 w-4 text-purple-500" />;
    case "completed":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "cancelled":
      return <XCircle className="h-4 w-4 text-zinc-400" />;
    default:
      return null;
  }
}

function priorityLabel(p: number): string {
  if (p >= 80) return "Critical";
  if (p >= 60) return "High";
  if (p >= 40) return "Medium";
  return "Low";
}

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<TaskItem | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api
      .get<TaskItem>(`tasks/${id}`)
      .then(setTask)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (!task) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        Task not found.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/tasks" className="hover:text-foreground">
          <ArrowLeft className="inline h-3.5 w-3.5 mr-1" />
          Tasks
        </Link>
        <span>/</span>
        <span className="text-foreground">{task.title}</span>
      </div>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          {statusIcon(task.status)}
          <h1 className="text-2xl font-semibold tracking-tight">
            {task.title}
          </h1>
        </div>
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>
            Priority: <strong>{task.priority}</strong> ({priorityLabel(task.priority)})
          </span>
          {task.assignedTo && <span>Assigned to: {task.assignedTo}</span>}
          <span>Created by: {task.createdBy}</span>
          <span>Created: {formatDateTime(task.createdAt)}</span>
          {task.completedAt && (
            <span>Completed: {formatDateTime(task.completedAt)}</span>
          )}
        </div>
      </div>

      {/* Description */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Description</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-sm">{task.description}</p>
          {task.context?.reasoning && (
            <div className="mt-4 pt-4 border-t">
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Reasoning
              </div>
              <p className="text-sm">{task.context.reasoning}</p>
            </div>
          )}
          {task.context?.relevantUrls && task.context.relevantUrls.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Relevant Links
              </div>
              <ul className="text-sm space-y-1">
                {task.context.relevantUrls.map((url, i) => (
                  <li key={i}>
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline"
                    >
                      {url}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Output */}
      {task.output && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Output</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-4 p-3 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-sm">
                <strong>Summary:</strong> {task.output.summary}
              </div>
              <div className="prose prose-invert prose-sm max-w-none">
                <ReactMarkdown>{task.output.content}</ReactMarkdown>
              </div>
            </CardContent>
          </Card>

          {/* Artifacts */}
          {task.output.artifacts.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Artifacts</h2>
              {task.output.artifacts.map((artifact, i) => (
                <Card key={i}>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      {artifact.name}
                      <Badge variant="outline" className="text-xs ml-2">
                        {artifact.type}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {artifact.type === "markdown" ? (
                      <div className="prose prose-invert prose-sm max-w-none">
                        <ReactMarkdown>{artifact.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <pre className="text-xs overflow-auto max-h-96 p-4 rounded-md bg-zinc-900 border">
                        {artifact.content}
                      </pre>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {/* Metadata */}
      {task.tokensUsed > 0 && (
        <div className="text-xs text-muted-foreground">
          Tokens used: {task.tokensUsed.toLocaleString()}
          {task.startedAt && task.completedAt && (
            <span className="ml-4">
              Duration:{" "}
              {Math.round(
                (new Date(task.completedAt).getTime() -
                  new Date(task.startedAt).getTime()) /
                  1000,
              )}
              s
            </span>
          )}
        </div>
      )}
    </div>
  );
}
