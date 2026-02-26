import { useEffect, useState, useCallback } from "react";
import {
  Play,
  PlayCircle,
  Loader2,
  CheckCircle2,
  Clock,
  CalendarDays,
} from "lucide-react";
import { Link } from "react-router-dom";
import { api, type JobStatus } from "@/lib/api";
import { cn, formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { HealthBadge } from "@/components/HealthBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function todayString(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Format an ISO date string as relative time from now.
 * e.g. "3 hours 12 minutes", "Tomorrow at 2:00 PM", "Monday at 2:00 PM"
 */
function relativeTime(isoDate: string): string {
  const target = new Date(isoDate);
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();

  if (diffMs <= 0) return "Now";

  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatExactTime(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function Jobs() {
  const [date, setDate] = useState(todayString);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState<Set<string>>(new Set());
  const [runningAll, setRunningAll] = useState(false);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<JobStatus[]>(`jobs/status?date=${date}`);
      setJobs(data);
    } catch (err) {
      console.error("Failed to load jobs:", err);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  async function triggerJob(agentId: string, reportType: string) {
    const key = `${agentId}:${reportType}`;
    setTriggering((prev) => new Set(prev).add(key));
    try {
      await api.post(`agents/${agentId}/trigger/${reportType}`);
      // Reload after a short delay to let the job complete
      setTimeout(loadJobs, 2000);
    } catch (err) {
      console.error("Failed to trigger job:", err);
    } finally {
      setTriggering((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function runAllMissing() {
    setRunningAll(true);
    try {
      const pending: Array<{ agentId: string; reportType: string }> = [];
      for (const job of jobs) {
        for (const report of job.expectedReports) {
          if (!report.completed) {
            pending.push({
              agentId: job.agentId,
              reportType: report.reportType,
            });
          }
        }
      }
      await Promise.all(
        pending.map(({ agentId, reportType }) =>
          api.post(`agents/${agentId}/trigger/${reportType}`),
        ),
      );
      // Reload after a short delay
      setTimeout(loadJobs, 3000);
    } catch (err) {
      console.error("Failed to run all:", err);
    } finally {
      setRunningAll(false);
    }
  }

  const totalJobs = jobs.reduce(
    (sum, j) => sum + j.expectedReports.length,
    0,
  );
  const completedJobs = jobs.reduce(
    (sum, j) => sum + j.expectedReports.filter((r) => r.completed).length,
    0,
  );
  const hasPending = completedJobs < totalJobs;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-sm text-muted-foreground">
            Report scheduling and execution status
          </p>
        </div>
        <div className="flex items-center gap-3">
          {hasPending && (
            <Button
              onClick={runAllMissing}
              disabled={runningAll || loading}
              size="sm"
            >
              {runningAll ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
                  Run All Missing
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Date Picker and Summary */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-44"
          />
        </div>
        <div className="text-sm text-muted-foreground">
          {completedJobs}/{totalJobs} completed
        </div>
      </div>

      {/* Jobs Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-sm text-muted-foreground">Loading...</div>
        </div>
      ) : jobs.length > 0 ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Report Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Next Run</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Last Run</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.flatMap((job) =>
                job.expectedReports.map((report) => {
                  const triggerKey = `${job.agentId}:${report.reportType}`;
                  const isTriggering = triggering.has(triggerKey);

                  return (
                    <TableRow key={triggerKey}>
                      <TableCell>
                        <Link
                          to={`/agents/${job.agentId}`}
                          className="font-medium hover:underline"
                        >
                          {job.agentName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {report.reportType}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {report.completed ? (
                          <span className="inline-flex items-center gap-1 text-sm text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Completed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-sm text-amber-600">
                            <Clock className="h-3.5 w-3.5" />
                            Scheduled
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {report.nextRunAt ? (
                          <span
                            className="cursor-default"
                            title={formatExactTime(report.nextRunAt)}
                          >
                            {formatExactTime(report.nextRunAt)}
                          </span>
                        ) : (
                          "--"
                        )}
                      </TableCell>
                      <TableCell>
                        {report.healthSignal ? (
                          <HealthBadge signal={report.healthSignal} />
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            --
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {report.completedAt
                          ? formatDateTime(report.completedAt)
                          : "--"}
                      </TableCell>
                      <TableCell className="text-right">
                        {!report.completed && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              triggerJob(job.agentId, report.reportType)
                            }
                            disabled={isTriggering}
                          >
                            {isTriggering ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                        {report.completed && report.reportId && (
                          <Link
                            to={`/agents/${job.agentId}/reports/${report.reportId}`}
                          >
                            <Button variant="ghost" size="sm">
                              View
                            </Button>
                          </Link>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                }),
              )}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No jobs configured for this date.
        </div>
      )}
    </div>
  );
}
