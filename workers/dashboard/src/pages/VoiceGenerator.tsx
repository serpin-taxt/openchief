import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Mic,
  Loader2,
  Copy,
  Check,
  ChevronLeft,
  Sparkles,
  Paintbrush,
  Search,
  UserCheck,
  ChevronDown,
} from "lucide-react";
import { api, type Identity } from "@/lib/api";
import type { AgentDefinition } from "@openchief/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface VoiceResult {
  voice: string;
  personality: string;
  outputStyle: string;
  messageCount: number;
  model: string;
  tokens: { input: number; output: number };
}

export function VoiceGenerator() {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<VoiceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Apply-to-agent state
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [identityData, agentData] = await Promise.all([
          api.get<Identity[]>("identities"),
          api.get<AgentDefinition[]>("agents"),
        ]);
        setIdentities(identityData.filter((id) => !id.isBot && id.isActive));
        setAgents(agentData.filter((a) => a.enabled));
      } catch (err) {
        console.error("Failed to load data:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return identities;
    const q = search.toLowerCase();
    return identities.filter(
      (id) =>
        id.displayName?.toLowerCase().includes(q) ||
        id.realName?.toLowerCase().includes(q) ||
        id.email?.toLowerCase().includes(q),
    );
  }, [identities, search]);

  const selectedPerson = identities.find((id) => id.id === selectedId);
  const targetAgent = agents.find((a) => a.id === targetAgentId);

  async function handleGenerate() {
    if (!selectedId) return;
    setAnalyzing(true);
    setError(null);
    setResult(null);
    setApplied(false);
    setTargetAgentId(null);

    try {
      const data = await api.post<VoiceResult>("tools/generate-voice", {
        identityId: selectedId,
      });
      setResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Analysis failed";
      try {
        const parsed = JSON.parse(msg) as { error?: string };
        setError(parsed.error || msg);
      } catch {
        setError(msg);
      }
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleApplyToAgent() {
    if (!targetAgentId || !result) return;
    setApplying(true);
    setError(null);

    try {
      const agent = agents.find((a) => a.id === targetAgentId);
      if (!agent) throw new Error("Agent not found");

      const updated: AgentDefinition = {
        ...agent,
        persona: {
          ...agent.persona,
          voice: result.voice,
          personality: result.personality,
          outputStyle: result.outputStyle,
        },
      };

      await api.put(`agents/${targetAgentId}`, updated);
      setApplied(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to apply";
      setError(msg);
    } finally {
      setApplying(false);
    }
  }

  function handleCopy(field: string, value: string) {
    navigator.clipboard.writeText(value);
    setCopied(field);
    setTimeout(() => setCopied(null), 2000);
  }

  function handleReset() {
    setSelectedId(null);
    setResult(null);
    setError(null);
    setSearch("");
    setApplied(false);
    setTargetAgentId(null);
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
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          to="/tools"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Voice Generator
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Analyze Slack messages to generate voice, personality, and output
            style
          </p>
        </div>
      </div>

      {/* Results view */}
      {result && selectedPerson && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {selectedPerson.avatarUrl && (
                <img
                  src={selectedPerson.avatarUrl}
                  alt=""
                  className="h-8 w-8 rounded-full"
                />
              )}
              <div>
                <p className="font-medium">
                  {selectedPerson.displayName || selectedPerson.realName}
                </p>
                <p className="text-xs text-muted-foreground">
                  Based on {result.messageCount} Slack messages
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleReset}>
              Analyze Another Person
            </Button>
          </div>

          <ResultCard
            icon={Mic}
            label="Voice"
            fieldName="voice"
            value={result.voice}
            copied={copied}
            onCopy={handleCopy}
          />

          <ResultCard
            icon={Sparkles}
            label="Personality"
            fieldName="personality"
            value={result.personality}
            copied={copied}
            onCopy={handleCopy}
          />

          <ResultCard
            icon={Paintbrush}
            label="Output Style"
            fieldName="outputStyle"
            value={result.outputStyle}
            copied={copied}
            onCopy={handleCopy}
          />

          {/* Apply to Agent section */}
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <UserCheck className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">Apply to Agent</span>
                  <span className="text-xs text-muted-foreground">
                    — sets voice, personality &amp; output style
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {/* Agent selector dropdown */}
                  <div className="relative">
                    <button
                      onClick={() => setAgentDropdownOpen(!agentDropdownOpen)}
                      className="flex h-9 min-w-[180px] items-center justify-between rounded-md border border-input bg-background px-3 text-sm transition-colors hover:bg-accent"
                    >
                      <span className={targetAgent ? "" : "text-muted-foreground"}>
                        {targetAgent ? targetAgent.name : "Select agent…"}
                      </span>
                      <ChevronDown className="ml-2 h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                    {agentDropdownOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setAgentDropdownOpen(false)}
                        />
                        <div className="absolute right-0 z-50 mt-1 max-h-60 w-56 overflow-auto rounded-md border border-border bg-popover shadow-lg">
                          {agents.map((agent) => (
                            <button
                              key={agent.id}
                              onClick={() => {
                                setTargetAgentId(agent.id);
                                setAgentDropdownOpen(false);
                                setApplied(false);
                              }}
                              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                                targetAgentId === agent.id ? "bg-accent" : ""
                              }`}
                            >
                              <span className="truncate">{agent.name}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  <Button
                    size="sm"
                    onClick={handleApplyToAgent}
                    disabled={!targetAgentId || applying || applied}
                  >
                    {applying ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Applying...
                      </>
                    ) : applied ? (
                      <>
                        <Check className="mr-1.5 h-3.5 w-3.5" />
                        Applied
                      </>
                    ) : (
                      "Apply"
                    )}
                  </Button>
                </div>
              </div>
              {applied && targetAgent && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Voice, personality, and output style applied to{" "}
                  <Link
                    to={`/agents/${targetAgent.id}`}
                    className="underline hover:text-foreground"
                  >
                    {targetAgent.name}
                  </Link>
                  . Changes take effect on the next report or chat.
                </p>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Model: {result.model} &middot; Tokens: {result.tokens.input} in /{" "}
            {result.tokens.output} out
          </p>
        </div>
      )}

      {/* Person selector (shown when no result) */}
      {!result && (
        <>
          {selectedPerson ? (
            <Card>
              <CardContent className="flex items-center gap-4 py-4">
                {selectedPerson.avatarUrl ? (
                  <img
                    src={selectedPerson.avatarUrl}
                    alt=""
                    className="h-10 w-10 rounded-full"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-sm font-medium">
                    {(
                      selectedPerson.displayName ||
                      selectedPerson.realName ||
                      "?"
                    )[0]}
                  </div>
                )}
                <div className="flex-1">
                  <p className="font-medium">
                    {selectedPerson.displayName || selectedPerson.realName}
                  </p>
                  {selectedPerson.email && (
                    <p className="text-sm text-muted-foreground">
                      {selectedPerson.email}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedId(null)}
                  >
                    Change
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleGenerate}
                    disabled={analyzing}
                  >
                    {analyzing ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Analyzing...
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                        Generate Persona
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search people..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>

              {/* People grid */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((person) => (
                  <button
                    key={person.id}
                    onClick={() => setSelectedId(person.id)}
                    className="flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-ring hover:bg-secondary/50"
                  >
                    {person.avatarUrl ? (
                      <img
                        src={person.avatarUrl}
                        alt=""
                        className="h-8 w-8 rounded-full"
                      />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
                        {(
                          person.displayName ||
                          person.realName ||
                          "?"
                        )[0]}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {person.displayName || person.realName}
                      </p>
                      {person.email && (
                        <p className="truncate text-xs text-muted-foreground">
                          {person.email}
                        </p>
                      )}
                    </div>
                    {person.slackUserId && (
                      <Badge
                        variant="outline"
                        className="ml-auto shrink-0 text-[10px]"
                      >
                        Slack
                      </Badge>
                    )}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
                    {search
                      ? "No people match your search"
                      : "No people found"}
                  </p>
                )}
              </div>
            </>
          )}

          {error && (
            <Card className="border-destructive/50">
              <CardContent className="py-4 text-sm text-destructive">
                {error}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Error in results view */}
      {result && error && (
        <Card className="border-destructive/50">
          <CardContent className="py-4 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ResultCard                                                          */
/* ------------------------------------------------------------------ */

function ResultCard({
  icon: Icon,
  label,
  fieldName,
  value,
  copied,
  onCopy,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  fieldName: string;
  value: string;
  copied: string | null;
  onCopy: (field: string, value: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm">{label}</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => onCopy(fieldName, value)}
          >
            {copied === fieldName ? (
              <>
                <Check className="h-3 w-3" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
