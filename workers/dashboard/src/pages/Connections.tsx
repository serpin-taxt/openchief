import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Activity } from "lucide-react";
import { api, type ConnectionStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { SourceIcon } from "@/components/SourceIcon";

export function Connections() {
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const connList = await api.get<ConnectionStatus[]>("connections");
        setConnections(connList);
      } catch (err) {
        console.error("Failed to load connections:", err);
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="text-sm text-muted-foreground">
            Data sources feeding events to your agents
          </p>
        </div>
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
