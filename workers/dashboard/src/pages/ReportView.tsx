import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentReport, AgentDefinition } from "@openchief/shared";
import { api } from "@/lib/api";
import { cn, formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HealthBadge } from "@/components/HealthBadge";

const severityStyles: Record<string, string> = {
  info: "border-l-blue-500",
  warning: "border-l-amber-500",
  critical: "border-l-red-500",
};

const severityBadge: Record<string, string> = {
  info: "bg-blue-500/15 text-blue-400 border border-blue-500/30",
  warning: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  critical: "bg-red-500/15 text-red-400 border border-red-500/30",
};

const priorityStyles: Record<string, string> = {
  low: "bg-muted text-muted-foreground border border-border",
  medium: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
  high: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  critical: "bg-red-500/15 text-red-400 border border-red-500/30",
};

export function ReportView() {
  const { id, reportId } = useParams<{ id: string; reportId: string }>();
  const [agent, setAgent] = useState<AgentDefinition | null>(null);
  const [report, setReport] = useState<AgentReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id || !reportId) return;
    async function load() {
      try {
        const [agentData, reportData] = await Promise.all([
          api.get<AgentDefinition>(`agents/${id}`),
          api.get<AgentReport>(`agents/${id}/reports/${reportId}`),
        ]);
        setAgent(agentData);
        setReport(reportData);
      } catch (err) {
        console.error("Failed to load report:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id, reportId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        Report not found.
      </div>
    );
  }

  const { content } = report;

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link to={`/modules/${id}`} className="hover:text-foreground">
          {agent?.name ?? id}
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span>Report</span>
      </div>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <HealthBadge signal={content.healthSignal} />
          <Badge variant="outline">{report.reportType}</Badge>
          <span className="text-sm text-muted-foreground">
            {formatDateTime(report.createdAt)}
          </span>
          <span className="text-sm text-muted-foreground">
            {report.eventCount} events analyzed
          </span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {content.headline}
        </h1>
      </div>

      {/* Sections */}
      <div className="space-y-4">
        {content.sections.map((section, i) => (
          <Card
            key={i}
            className={cn(
              "border-l-4",
              severityStyles[section.severity] ?? severityStyles.info,
            )}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">{section.name}</CardTitle>
                {section.severity && section.severity !== "info" && (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                      severityBadge[section.severity],
                    )}
                  >
                    {section.severity}
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm prose-invert max-w-none prose-p:text-muted-foreground prose-li:text-muted-foreground prose-strong:text-foreground prose-a:text-primary prose-headings:text-foreground">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {section.body}
                </ReactMarkdown>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Action Items */}
      {content.actionItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Action Items</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {content.actionItems.map((item, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
                      priorityStyles[item.priority] ?? priorityStyles.medium,
                    )}
                  >
                    {item.priority}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{item.description}</p>
                    {item.assignee && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Assignee: {item.assignee}
                      </p>
                    )}
                    {item.sourceUrl && (
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 text-xs text-primary hover:underline"
                      >
                        View source
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
