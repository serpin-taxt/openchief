import { useEffect, useState, useMemo } from "react";
import { Users, GitMerge, Loader2, Bot, User } from "lucide-react";
import { api, type Identity } from "@/lib/api";
import { cn } from "@/lib/utils";
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

type FilterTab = "all" | "people" | "bots";

export function Team() {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>("people");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const data = await api.get<Identity[]>("identities");
        setIdentities(data);
      } catch (err) {
        console.error("Failed to load identities:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filtered = useMemo(() => {
    switch (filter) {
      case "people":
        return identities.filter((id) => !id.isBot);
      case "bots":
        return identities.filter((id) => id.isBot);
      default:
        return identities;
    }
  }, [identities, filter]);

  function toggleSelection(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        // Max 2 selections for merge
        if (next.size >= 2) return prev;
        next.add(id);
      }
      return next;
    });
  }

  async function handleMerge() {
    if (selected.size !== 2) return;
    const [primaryId, secondaryId] = Array.from(selected);

    const primary = identities.find((i) => i.id === primaryId);
    const secondary = identities.find((i) => i.id === secondaryId);
    if (!primary || !secondary) return;

    const confirmed = window.confirm(
      `Merge "${secondary.realName}" into "${primary.realName}"? The first selected identity will be kept as the primary record.`,
    );
    if (!confirmed) return;

    setMerging(true);
    try {
      await api.post("identities/merge", { primaryId, secondaryId });
      // Reload
      const data = await api.get<Identity[]>("identities");
      setIdentities(data);
      setSelected(new Set());
    } catch (err) {
      console.error("Failed to merge:", err);
    } finally {
      setMerging(false);
    }
  }

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
          <h1 className="text-2xl font-semibold tracking-tight">Humans</h1>
          <p className="text-sm text-muted-foreground">
            Identity mappings across connected services
          </p>
        </div>
        {selected.size === 2 && (
          <Button
            onClick={handleMerge}
            disabled={merging}
            variant="default"
            size="sm"
          >
            {merging ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Merging...
              </>
            ) : (
              <>
                <GitMerge className="mr-1.5 h-3.5 w-3.5" />
                Merge Selected
              </>
            )}
          </Button>
        )}
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-1 rounded-lg border p-1 w-fit">
        {(
          [
            { key: "people", label: "People", icon: User },
            { key: "bots", label: "Bots", icon: Bot },
            { key: "all", label: "All", icon: Users },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => {
              setFilter(key);
              setSelected(new Set());
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              filter === key
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {selected.size > 0 && selected.size < 2 && (
        <p className="text-sm text-muted-foreground">
          Select one more identity to merge. The first selected will be the
          primary record.
        </p>
      )}

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>Name</TableHead>
              <TableHead>GitHub</TableHead>
              <TableHead>Slack</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Figma</TableHead>
              <TableHead>Discord</TableHead>
              <TableHead>Team</TableHead>
              <TableHead>Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((identity) => {
              const isSelected = selected.has(identity.id);
              return (
                <TableRow
                  key={identity.id}
                  className={cn(isSelected && "bg-primary/5")}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelection(identity.id)}
                      disabled={!isSelected && selected.size >= 2}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {identity.avatarUrl ? (
                        <img
                          src={identity.avatarUrl}
                          alt=""
                          className="h-6 w-6 rounded-full"
                        />
                      ) : (
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted">
                          <User className="h-3 w-3 text-muted-foreground" />
                        </div>
                      )}
                      <span className="font-medium text-sm">
                        {identity.displayName ?? identity.realName}
                      </span>
                      {identity.isBot && (
                        <Badge variant="secondary" className="text-xs">
                          Bot
                        </Badge>
                      )}
                      {!identity.isActive && (
                        <Badge variant="outline" className="text-xs">
                          Inactive
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {identity.githubUsername ?? "--"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {identity.slackUserId ?? "--"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {identity.email ?? "--"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {identity.figmaHandle ?? "--"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {identity.discordHandle ?? "--"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {identity.team ?? "--"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {identity.role ?? "--"}
                  </TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    No identities found.
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
