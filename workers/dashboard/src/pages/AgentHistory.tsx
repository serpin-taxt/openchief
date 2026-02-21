import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { AgentRevision, AgentDefinition } from "@openchief/shared";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function AgentHistory() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentDefinition | null>(null);
  const [revisions, setRevisions] = useState<AgentRevision[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    async function load() {
      try {
        const [agentData, revisionList] = await Promise.all([
          api.get<AgentDefinition>(`agents/${id}`),
          api.get<AgentRevision[]>(`agents/${id}/revisions`),
        ]);
        setAgent(agentData);
        setRevisions(revisionList);
      } catch (err) {
        console.error("Failed to load revisions:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
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
        <span>History</span>
      </div>

      <h1 className="text-2xl font-semibold tracking-tight">
        Revision History
      </h1>

      {revisions.length > 0 ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Changed By</TableHead>
                <TableHead>Change Note</TableHead>
                <TableHead>Revision ID</TableHead>
                <TableHead className="text-right">Timestamp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {revisions.map((rev) => (
                <TableRow key={rev.id}>
                  <TableCell className="font-medium">
                    {rev.changedBy}
                  </TableCell>
                  <TableCell>{rev.changeNote}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-xs">
                      {rev.id.slice(0, 12)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatDateTime(rev.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No revisions recorded yet.
        </p>
      )}
    </div>
  );
}
