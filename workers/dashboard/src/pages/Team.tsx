import { useEffect, useState, useMemo } from "react";
import { Users, GitMerge, Loader2, Bot, User, ShieldCheck, Crown, EyeOff, Eye } from "lucide-react";
import { api, type Identity } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type FilterTab = "people" | "bots" | "all";

export function Team() {
  const { role: currentUserRole } = useAuth();
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>("people");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);
  const [updatingRole, setUpdatingRole] = useState<string | null>(null);
  const [updatingActive, setUpdatingActive] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

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

  const hiddenCount = useMemo(
    () => identities.filter((id) => !id.isActive).length,
    [identities],
  );

  const filtered = useMemo(() => {
    let result: Identity[];
    switch (filter) {
      case "people":
        result = identities.filter((id) => !id.isBot);
        break;
      case "bots":
        result = identities.filter((id) => id.isBot);
        break;
      default:
        result = identities;
    }
    if (!showHidden) {
      result = result.filter((id) => id.isActive);
    }
    return result;
  }, [identities, filter, showHidden]);

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
      alert(`Merge failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setMerging(false);
    }
  }

  async function handleToggleExec(identity: Identity) {
    const newRole = identity.role === "exec" ? null : "exec";
    const action = newRole === "exec" ? "promote" : "demote";
    const name = bestName(identity);
    const confirmed = window.confirm(
      `${action === "promote" ? "Promote" : "Demote"} "${name}" ${action === "promote" ? "to Exec" : "from Exec"}?`,
    );
    if (!confirmed) return;

    setUpdatingRole(identity.id);
    try {
      await api.put(`identities/${identity.id}/role`, { role: newRole });
      // Update locally
      setIdentities((prev) =>
        prev.map((i) =>
          i.id === identity.id ? { ...i, role: newRole } : i,
        ),
      );
    } catch (err) {
      console.error("Failed to update role:", err);
    } finally {
      setUpdatingRole(null);
    }
  }

  async function handleToggleActive(identity: Identity) {
    const newActive = !identity.isActive;
    const name = bestName(identity);
    const action = newActive ? "Show" : "Hide";
    const confirmed = window.confirm(
      `${action} "${name}" on the team page?`,
    );
    if (!confirmed) return;

    setUpdatingActive(identity.id);
    try {
      await api.put(`identities/${identity.id}/active`, { isActive: newActive });
      setIdentities((prev) =>
        prev.map((i) =>
          i.id === identity.id ? { ...i, isActive: newActive } : i,
        ),
      );
    } catch (err) {
      console.error("Failed to update visibility:", err);
    } finally {
      setUpdatingActive(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  /** Pick the best display name — prefer the longer of displayName/realName
   *  since it's more likely to be the full name (e.g. "Sean Waters" > "Sean") */
  function bestName(identity: Identity): string {
    const d = identity.displayName;
    const r = identity.realName;
    if (!d) return r;
    if (!r) return d;
    return d.length >= r.length ? d : r;
  }

  function renderTable(items: Identity[]) {
    return (
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
            {items.map((identity) => {
              const isSelected = selected.has(identity.id);
              return (
                <TableRow
                  key={identity.id}
                  className={cn(isSelected && "bg-primary/5")}
                >
                  <TableCell>
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleSelection(identity.id)}
                      disabled={!isSelected && selected.size >= 2}
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
                        {bestName(identity)}
                      </span>
                      {identity.isBot && (
                        <Badge variant="secondary" className="text-xs">
                          Bot
                        </Badge>
                      )}
                      {!identity.isActive && (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          Hidden
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
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {identity.role === "superadmin" && (
                        <Badge className="bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300 text-xs">
                          <Crown className="mr-1 h-3 w-3" />
                          Superadmin
                        </Badge>
                      )}
                      {identity.role === "exec" && (
                        <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 text-xs">
                          <ShieldCheck className="mr-1 h-3 w-3" />
                          Exec
                        </Badge>
                      )}
                      {!identity.role && (
                        <span className="text-sm text-muted-foreground">--</span>
                      )}
                      {/* Superadmin can promote/demote non-bot, non-superadmin identities */}
                      {currentUserRole === "superadmin" &&
                        !identity.isBot &&
                        identity.role !== "superadmin" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                            disabled={updatingRole === identity.id}
                            onClick={() => handleToggleExec(identity)}
                          >
                            {updatingRole === identity.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : identity.role === "exec" ? (
                              "Demote"
                            ) : (
                              "Make Exec"
                            )}
                          </Button>
                        )}
                      {/* Superadmin can hide/show identities */}
                      {currentUserRole === "superadmin" &&
                        identity.role !== "superadmin" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-muted-foreground hover:text-foreground"
                            disabled={updatingActive === identity.id}
                            onClick={() => handleToggleActive(identity)}
                            title={identity.isActive ? "Hide from team page" : "Show on team page"}
                          >
                            {updatingActive === identity.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : identity.isActive ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {items.length === 0 && (
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

      {selected.size > 0 && selected.size < 2 && (
        <p className="text-sm text-muted-foreground">
          Select one more identity to merge. The first selected will be the
          primary record.
        </p>
      )}

      <Tabs
        value={filter}
        onValueChange={(v) => {
          setFilter(v as FilterTab);
          setSelected(new Set());
        }}
      >
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="people">
              <User className="h-3.5 w-3.5" />
              People
            </TabsTrigger>
            <TabsTrigger value="bots">
              <Bot className="h-3.5 w-3.5" />
              Bots
            </TabsTrigger>
            <TabsTrigger value="all">
              <Users className="h-3.5 w-3.5" />
              All
            </TabsTrigger>
          </TabsList>
          {currentUserRole === "superadmin" && hiddenCount > 0 && (
            <Button
              variant={showHidden ? "secondary" : "ghost"}
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={() => setShowHidden((v) => !v)}
            >
              <EyeOff className="mr-1.5 h-3.5 w-3.5" />
              {showHidden ? "Hide" : "Show"} hidden ({hiddenCount})
            </Button>
          )}
        </div>

        <TabsContent value="people">
          {renderTable(filtered)}
        </TabsContent>
        <TabsContent value="bots">
          {renderTable(filtered)}
        </TabsContent>
        <TabsContent value="all">
          {renderTable(filtered)}
        </TabsContent>
      </Tabs>
    </div>
  );
}
