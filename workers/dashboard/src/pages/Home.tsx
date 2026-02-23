import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Activity } from "lucide-react";
import type { AgentDefinition, AgentReport } from "@openchief/shared";
import { api, type ConnectionStatus } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SourceIcon } from "@/components/SourceIcon";

interface AgentWithReports extends AgentDefinition {
  recentReports: AgentReport[];
  avatarUrl?: string | null;
}

/** Get today and yesterday date strings in YYYY-MM-DD (local time). */
function todayYesterday(): { today: string; yesterday: string } {
  const now = new Date();
  const today = now.toLocaleDateString("en-CA"); // YYYY-MM-DD
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = y.toLocaleDateString("en-CA");
  return { today, yesterday };
}

/** Find the first daily report whose createdAt falls on the given local date. */
function reportForDate(reports: AgentReport[], date: string): AgentReport | undefined {
  return reports.find((r) => {
    // Only match daily reports (skip weekly) for today/yesterday cards
    if (r.reportType?.includes("weekly")) return false;
    // Compare in local time so the card matches what the user sees
    const local = new Date(r.createdAt).toLocaleDateString("en-CA");
    return local === date;
  });
}

const healthDotColor: Record<string, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
};

const healthBorder: Record<string, string> = {
  green: "hover:border-emerald-500/60",
  yellow: "hover:border-amber-500/60",
  red: "hover:border-red-500/60",
};

const healthGradient: Record<string, string> = {
  green: "from-emerald-500/[0.125] from-0% to-transparent to-50%",
  yellow: "from-amber-500/[0.125] from-0% to-transparent to-50%",
  red: "from-red-500/[0.125] from-0% to-transparent to-50%",
};

export function Home() {
  const [agents, setAgents] = useState<AgentWithReports[]>([]);
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [agentList, connList] = await Promise.all([
          api.get<AgentDefinition[]>("agents"),
          api.get<ConnectionStatus[]>("connections").catch(() => [] as ConnectionStatus[]),
        ]);

        // Fetch recent reports for each agent (enough to cover today + yesterday)
        const withReports = await Promise.all(
          agentList.map(async (agent) => {
            try {
              const reports = await api.get<AgentReport[]>(
                `agents/${agent.id}/reports`,
              );
              return { ...agent, recentReports: reports.slice(0, 20) };
            } catch {
              return { ...agent, recentReports: [] };
            }
          }),
        );

        setAgents(withReports);
        setConnections(connList);
      } catch (err) {
        console.error("Failed to load dashboard data:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* Agents Section */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Agents</h2>
          <span className="text-sm text-muted-foreground">
            {agents.length} configured
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...agents.filter((a) => a.visibility === "exec"), ...agents.filter((a) => a.visibility !== "exec")].map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
          {agents.length === 0 && (
            <p className="col-span-full text-sm text-muted-foreground">
              No agents configured yet.
            </p>
          )}
        </div>
      </section>

      {/* Connections Section */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">
            Connections
          </h2>
          <span className="text-sm text-muted-foreground">
            {connections.length} sources
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {connections.map((conn) => (
            <ConnectionCard key={conn.source} connection={conn} />
          ))}
          {connections.length === 0 && (
            <p className="col-span-full text-sm text-muted-foreground">
              No connections configured yet.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentWithReports }) {
  const { today, yesterday } = todayYesterday();
  const todayReport = reportForDate(agent.recentReports, today);
  const yesterdayReport = reportForDate(agent.recentReports, yesterday);
  const latestReport = agent.recentReports[0] ?? null;
  const healthSignal = latestReport?.content?.healthSignal ?? null;
  const dotColor = healthSignal ? (healthDotColor[healthSignal] ?? "bg-muted-foreground/50") : "bg-muted-foreground/30";

  return (
    <Link to={`/modules/${agent.id}`}>
      <Card className={cn("relative h-full overflow-hidden transition-all hover:shadow-md", healthSignal ? healthBorder[healthSignal] : "")}>
        {agent.avatarUrl && (
          <div className="absolute inset-0 pointer-events-none">
            <img
              src={agent.avatarUrl}
              alt=""
              className="h-full w-full object-cover opacity-30 grayscale"
            />
            <div className={cn("absolute inset-0 bg-gradient-to-t", healthSignal ? (healthGradient[healthSignal] ?? "from-card/90 from-10% via-card/60 to-card/30") : "from-card/90 from-10% via-card/60 to-card/30")} />
          </div>
        )}
        <CardHeader className="relative pb-2">
          <div className="flex items-center gap-2">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", dotColor)} />
            <CardTitle className="text-base">{agent.name}</CardTitle>
            {agent.visibility === "exec" && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-0.5 border-amber-500/40 bg-amber-500/15 text-amber-400">
                Exec
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="relative space-y-2.5">
          <ReportLine label="Today" report={todayReport} />
          <ReportLine label="Yesterday" report={yesterdayReport} />
        </CardContent>
      </Card>
    </Link>
  );
}

function ReportLine({ label, report }: { label: string; report?: AgentReport }) {
  return (
    <div>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {report?.content?.headline ? (
        <p className="mt-0.5 line-clamp-2 text-sm leading-snug">
          {report.content.headline}
        </p>
      ) : (
        <p className="mt-0.5 text-sm italic text-muted-foreground/60">
          No report
        </p>
      )}
    </div>
  );
}

function ConnectionCard({ connection }: { connection: ConnectionStatus }) {
  return (
    <Link to={`/connections/${connection.source}`} className="group">
      <Card className="h-full transition-shadow hover:shadow-md">
        <CardContent className="flex items-center gap-4 p-5">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
              connection.eventCount > 0
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
            )}
          >
            <SourceIcon name={connection.source} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{connection.label}</span>
              {connection.eventCount > 0 && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Activity className="h-3 w-3" />
                  {connection.eventCount.toLocaleString()}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {connection.lastEventAt
                ? `Last event ${timeAgo(connection.lastEventAt)}`
                : "No events yet"}
            </p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </CardContent>
      </Card>
    </Link>
  );
}
