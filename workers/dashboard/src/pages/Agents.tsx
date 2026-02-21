import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { AgentDefinition, AgentReport } from "@openchief/shared";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HealthBadge } from "@/components/HealthBadge";

interface AgentWithReport extends AgentDefinition {
  latestReport?: AgentReport | null;
  avatarUrl?: string | null;
}

export function Agents() {
  const [agents, setAgents] = useState<AgentWithReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const agentList = await api.get<AgentDefinition[]>("agents");

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
      } catch (err) {
        console.error("Failed to load agents:", err);
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

  const execAgents = agents.filter((a) => a.visibility === "exec");
  const humanAgents = agents.filter((a) => a.visibility !== "exec");

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground">
            AI agents monitoring your business tools
          </p>
        </div>
        <span className="text-sm text-muted-foreground">
          {agents.length} configured
        </span>
      </div>

      {/* Exec agents */}
      {execAgents.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-500/70">
            Exec
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {execAgents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        </section>
      )}

      {/* Human agents */}
      {humanAgents.length > 0 && (
        <section>
          {execAgents.length > 0 && (
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
              Managers
            </h2>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {humanAgents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        </section>
      )}

      {agents.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No agents configured yet.
        </p>
      )}
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
