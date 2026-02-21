import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Activity } from "lucide-react";
import type { AgentDefinition, AgentReport } from "@openchief/shared";
import { api, type ConnectionStatus } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HealthBadge } from "@/components/HealthBadge";
import { SourceIcon } from "@/components/SourceIcon";

interface AgentWithReport extends AgentDefinition {
  latestReport?: AgentReport | null;
  avatarUrl?: string | null;
}

export function Home() {
  const [agents, setAgents] = useState<AgentWithReport[]>([]);
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [agentList, connList] = await Promise.all([
          api.get<AgentDefinition[]>("agents"),
          api.get<ConnectionStatus[]>("connections"),
        ]);

        // Fetch latest report for each agent in parallel
        const withReports = await Promise.all(
          agentList.map(async (agent) => {
            try {
              const report = await api.get<AgentReport>(
                `agents/${agent.id}/reports/latest`,
              );
              return { ...agent, latestReport: report };
            } catch {
              return { ...agent, latestReport: null };
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

function AgentCard({ agent }: { agent: AgentWithReport }) {
  const report = agent.latestReport;
  const healthSignal = report?.content?.healthSignal ?? null;

  return (
    <Link to={`/modules/${agent.id}`} className="group">
      <Card className="relative h-full overflow-hidden transition-shadow hover:shadow-md">
        {agent.avatarUrl && (
          <div className="absolute inset-0 pointer-events-none">
            <img
              src={agent.avatarUrl}
              alt=""
              className="h-full w-full object-cover opacity-30"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-card/90 from-10% via-card/50 to-card/25" />
          </div>
        )}
        <CardHeader className="relative pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">{agent.name}</CardTitle>
              {agent.visibility === "exec" && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-0.5 border-amber-500/40 bg-amber-500/15 text-amber-400">
                  Exec
                </Badge>
              )}
            </div>
            {healthSignal && <HealthBadge signal={healthSignal} />}
          </div>
        </CardHeader>
        <CardContent className="relative">
          <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
            {agent.description}
          </p>
          {report?.content?.headline ? (
            <p className="line-clamp-2 text-sm font-medium">
              {report.content.headline}
            </p>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              No reports yet
            </p>
          )}
          <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            View details
            <ArrowRight className="h-3 w-3" />
          </div>
        </CardContent>
      </Card>
    </Link>
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
