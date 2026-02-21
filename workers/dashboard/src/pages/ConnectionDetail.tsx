import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ChevronRight,
  Save,
  Eye,
  EyeOff,
  Shield,
  Loader2,
} from "lucide-react";
import {
  api,
  type ConnectorConfigResponse,
  type ConnectorConfigField,
  type ConnectionEvent,
} from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SourceIcon } from "@/components/SourceIcon";

interface AgentAccess {
  agentId: string;
  agentName: string;
  tools: string[];
}

export function ConnectionDetail() {
  const { source } = useParams<{ source: string }>();
  const [config, setConfig] = useState<ConnectorConfigResponse | null>(null);
  const [events, setEvents] = useState<ConnectionEvent[]>([]);
  const [agentAccess, setAgentAccess] = useState<AgentAccess[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!source) return;
    try {
      const [configData, eventData, accessData] = await Promise.all([
        api
          .get<ConnectorConfigResponse>(`connections/${source}/settings`)
          .catch(() => null),
        api
          .get<ConnectionEvent[]>(`connections/${source}/events?limit=100`)
          .catch(() => []),
        api
          .get<AgentAccess[]>(`connections/${source}/access`)
          .catch(() => []),
      ]);
      setConfig(configData);
      setEvents(eventData);
      setAgentAccess(accessData);
    } catch (err) {
      console.error("Failed to load connection:", err);
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function handleFieldChange(key: string, value: string) {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  }

  function toggleReveal(key: string) {
    setRevealedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function handleSave() {
    if (!source) return;
    setSaving(true);
    try {
      await api.put(`connections/${source}/settings`, fieldValues);
      setFieldValues({});
      await loadData();
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  }

  const hasChanges = Object.keys(fieldValues).length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="capitalize">{config?.label ?? source}</span>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <SourceIcon name={source ?? ""} />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {config?.label ?? source}
          </h1>
          {config?.workerName && (
            <p className="text-sm text-muted-foreground">
              Worker: {config.workerName}
            </p>
          )}
        </div>
      </div>

      {/* Configuration */}
      {config && config.fields.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
            <CardDescription>
              Manage connection credentials and settings
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {config.fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                value={fieldValues[field.key] ?? ""}
                revealed={revealedFields.has(field.key)}
                onValueChange={(v) => handleFieldChange(field.key, v)}
                onToggleReveal={() => toggleReveal(field.key)}
              />
            ))}
            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={!hasChanges || saving}
                size="sm"
              >
                {saving ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                    Save Settings
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agent Access */}
      {agentAccess.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Agent Access</CardTitle>
            </div>
            <CardDescription>
              Agents with tool-based access to this connection
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {agentAccess.map((access) => (
                <div
                  key={access.agentId}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <Link
                    to={`/modules/${access.agentId}`}
                    className="font-medium text-sm hover:underline"
                  >
                    {access.agentName}
                  </Link>
                  <div className="flex gap-1">
                    {access.tools.map((tool) => (
                      <Badge key={tool} variant="secondary" className="text-xs">
                        {tool}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Events */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Events</CardTitle>
          <CardDescription>
            Last {events.length} events from this source
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length > 0 ? (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event Type</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {event.eventType}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-sm">
                        {event.summary}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {event.actor ?? "--"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {event.project ?? "--"}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {timeAgo(event.timestamp)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No events recorded yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FieldRow sub-component
// ---------------------------------------------------------------------------

function FieldRow({
  field,
  value,
  revealed,
  onValueChange,
  onToggleReveal,
}: {
  field: ConnectorConfigField;
  value: string;
  revealed: boolean;
  onValueChange: (value: string) => void;
  onToggleReveal: () => void;
}) {
  const showMasked = field.secret && field.configured && !value && !revealed;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">
          {field.label}
          {field.required && (
            <span className="ml-0.5 text-destructive">*</span>
          )}
        </label>
        {field.configured && (
          <Badge variant="secondary" className="text-xs">
            Configured
          </Badge>
        )}
      </div>
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      <div className="flex gap-2">
        <Input
          type={field.secret && !revealed ? "password" : "text"}
          value={showMasked ? (field.maskedValue ?? "") : value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={field.placeholder ?? undefined}
          disabled={showMasked}
          className="font-mono text-sm"
        />
        {field.secret && (
          <Button
            variant="outline"
            size="icon"
            onClick={onToggleReveal}
            type="button"
          >
            {revealed ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
      {field.updatedAt && (
        <p className="text-xs text-muted-foreground">
          Last updated {timeAgo(field.updatedAt)}
        </p>
      )}
    </div>
  );
}
