import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
} from "react";
import { useParams } from "react-router-dom";
import { X, Send, Loader2, MessageCircle, Wrench } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, parseSSEStream, type ChatMessage } from "@/lib/api";
import type { AgentDefinition } from "@openchief/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolStatus {
  name: string;
  status: "running" | "complete" | "error";
}

interface ConfigUpdate {
  field: string;
  value: unknown;
  description: string;
}

interface DisplayMessage extends ChatMessage {
  toolStatus?: ToolStatus | null;
  configUpdates?: ConfigUpdate[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `<config_update>` JSON blocks from assistant text.
 * Returns the cleaned text and any parsed config update proposals.
 */
function parseConfigUpdates(text: string): {
  cleanText: string;
  updates: ConfigUpdate[];
} {
  const updates: ConfigUpdate[] = [];
  const cleanText = text.replace(
    /<config_update>([\s\S]*?)<\/config_update>/g,
    (_match, json: string) => {
      try {
        const parsed = JSON.parse(json.trim());
        if (parsed.field && parsed.description) {
          updates.push(parsed as ConfigUpdate);
        }
      } catch {
        // Malformed JSON, ignore
      }
      return "";
    },
  );
  return { cleanText: cleanText.trim(), updates };
}

/**
 * Apply a config change to an agent definition by mutating the appropriate
 * nested field. Supports dotted paths like "persona.watchPatterns".
 */
function applyConfigChange(
  agent: AgentDefinition,
  field: string,
  value: unknown,
): AgentDefinition {
  const clone = JSON.parse(JSON.stringify(agent)) as AgentDefinition;
  const parts = field.split(".");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    if (target[parts[i]] === undefined) {
      target[parts[i]] = {};
    }
    target = target[parts[i]];
  }
  target[parts[parts.length - 1]] = value;

  return clone;
}

// ---------------------------------------------------------------------------
// ChatSidebar
// ---------------------------------------------------------------------------

export function ChatSidebar() {
  const { id: agentId } = useParams<{ id: string }>();
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<AgentDefinition | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [currentToolStatus, setCurrentToolStatus] =
    useState<ToolStatus | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Track how many messages came from history so we only animate new ones
  const historyCountRef = useRef(0);

  // ---------------------------------------------------------------------------
  // Load agent definition and chat history when agent changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setMessages([]);
    setInput("");
    setCurrentToolStatus(null);
    historyCountRef.current = 0;

    if (agentId) {
      api
        .get<AgentDefinition>(`agents/${agentId}`)
        .then(setAgent)
        .catch(() => setAgent(null));

      // Load chat history
      api
        .get<ChatMessage[]>(`agents/${agentId}/chat/history`)
        .then((history) => {
          const mapped = history.map((m) => {
            const { cleanText, updates } = parseConfigUpdates(m.content);
            return {
              ...m,
              content: cleanText,
              configUpdates: updates.length > 0 ? updates : undefined,
            };
          });
          historyCountRef.current = mapped.length;
          setMessages(mapped);
        })
        .catch(() => {});
    } else {
      setAgent(null);
    }
  }, [agentId]);

  // Auto-scroll: instant on history load / open, smooth during streaming
  const scrollToBottom = useCallback((instant?: boolean) => {
    bottomRef.current?.scrollIntoView({
      behavior: instant ? "instant" : "smooth",
    });
  }, []);

  // Scroll when messages change — instant unless actively streaming
  useEffect(() => {
    scrollToBottom(!streaming);
  }, [messages, currentToolStatus, streaming, scrollToBottom]);

  // Instant scroll + focus when chat opens
  useEffect(() => {
    if (open) {
      // Use rAF to ensure DOM has rendered the message list
      requestAnimationFrame(() => scrollToBottom(true));
      inputRef.current?.focus();
    }
  }, [open, scrollToBottom]);

  // Auto-resize textarea
  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      const el = e.target;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Send message with SSE streaming (with automatic retry)
  // ---------------------------------------------------------------------------

  /** Execute a single chat request and process the SSE stream. */
  const executeChatRequest = useCallback(
    async (
      chatAgentId: string,
      allMessages: DisplayMessage[],
    ): Promise<boolean> => {
      const res = await fetch(`/api/agents/${chatAgentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: allMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.ok) {
        // Try to extract the server error message
        let serverMsg = `Chat request failed (${res.status})`;
        try {
          const errBody = await res.json() as { error?: string };
          if (errBody.error) serverMsg = errBody.error;
        } catch { /* ignore parse errors */ }

        const err = new Error(serverMsg);
        // Mark non-retryable errors so the retry loop can skip them
        (err as Error & { noRetry?: boolean }).noRetry =
          res.status === 429 || res.status === 403 || res.status === 400;
        throw err;
      }

      let accumulated = "";
      let gotContent = false;

      for await (const evt of parseSSEStream(res)) {
        switch (evt.event) {
          case "delta": {
            try {
              const parsed = JSON.parse(evt.data);
              const token =
                parsed.delta?.text ??
                parsed.choices?.[0]?.delta?.content ??
                parsed.content ??
                parsed.text ??
                "";
              if (token) {
                gotContent = true;
                accumulated += token;
                const { cleanText, updates } =
                  parseConfigUpdates(accumulated);
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: cleanText,
                    configUpdates:
                      updates.length > 0 ? updates : undefined,
                  };
                  return updated;
                });
              }
            } catch {
              // Non-JSON delta, treat as raw text
              gotContent = true;
              accumulated += evt.data;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: accumulated,
                };
                return updated;
              });
            }
            break;
          }

          case "tool_status": {
            try {
              const status = JSON.parse(evt.data) as ToolStatus;
              setCurrentToolStatus(status);
              if (status.status === "complete" || status.status === "error") {
                setTimeout(() => setCurrentToolStatus(null), 1500);
              }
            } catch {
              // Ignore malformed tool status
            }
            break;
          }

          case "done": {
            setCurrentToolStatus(null);
            break;
          }

          case "error": {
            // If we already have content, show it; otherwise mark as failed
            if (!accumulated) throw new Error("Server returned error event");
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = {
                role: "assistant",
                content: accumulated,
              };
              return updated;
            });
            break;
          }

          default:
            break;
        }
      }

      return gotContent;
    },
    [],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !agentId) return;

    const userMsg: DisplayMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setStreaming(true);
    setCurrentToolStatus(null);

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    // Add placeholder assistant message
    const assistantMsg: DisplayMessage = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);

    const allMessages = [...messages, userMsg];
    const MAX_RETRIES = 1;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          // Reset assistant placeholder for retry
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: "",
            };
            return updated;
          });
          setCurrentToolStatus(null);
          // Brief delay before retry
          await new Promise((r) => setTimeout(r, 500));
        }

        const gotContent = await executeChatRequest(agentId, allMessages);
        if (gotContent) break; // Success — exit retry loop

        // No content received — treat as failure and retry
        if (attempt < MAX_RETRIES) {
          console.warn(`Chat returned no content, retrying (attempt ${attempt + 1})...`);
          continue;
        }

        // Final attempt with no content
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: "Something went wrong. Please try again.",
          };
          return updated;
        });
      } catch (err) {
        console.error(`Chat error (attempt ${attempt}):`, err);
        const noRetry = (err as Error & { noRetry?: boolean }).noRetry;
        if (!noRetry && attempt < MAX_RETRIES) {
          console.warn("Retrying chat request...");
          continue;
        }
        // Final attempt or non-retryable error — show the actual message
        const errorMsg = err instanceof Error ? err.message : "Something went wrong.";
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: errorMsg,
          };
          return updated;
        });
      }
    }

    setStreaming(false);
    setCurrentToolStatus(null);
  }, [input, streaming, agentId, messages, executeChatRequest]);

  // ---------------------------------------------------------------------------
  // Apply config proposal
  // ---------------------------------------------------------------------------
  const handleApplyConfig = useCallback(
    async (update: ConfigUpdate, msgIndex: number) => {
      if (!agent || !agentId) return;

      const updated = applyConfigChange(agent, update.field, update.value);

      try {
        await api.put(`agents/${agentId}`, updated);
        setAgent(updated);

        // Remove the applied config update from the message
        setMessages((prev) => {
          const copy = [...prev];
          const msg = { ...copy[msgIndex] };
          msg.configUpdates = msg.configUpdates?.filter(
            (u) => u.field !== update.field,
          );
          if (msg.configUpdates?.length === 0) {
            msg.configUpdates = undefined;
          }
          copy[msgIndex] = msg;
          return copy;
        });
      } catch (err) {
        console.error("Failed to apply config change:", err);
      }
    },
    [agent, agentId],
  );

  const handleDismissConfig = useCallback(
    (update: ConfigUpdate, msgIndex: number) => {
      setMessages((prev) => {
        const copy = [...prev];
        const msg = { ...copy[msgIndex] };
        msg.configUpdates = msg.configUpdates?.filter(
          (u) => u.field !== update.field,
        );
        if (msg.configUpdates?.length === 0) {
          msg.configUpdates = undefined;
        }
        copy[msgIndex] = msg;
        return copy;
      });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Keyboard handler
  // ---------------------------------------------------------------------------
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const agentName = agent?.name ?? "Agent";

  return (
    <>
      {/* Floating toggle button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105"
          aria-label="Open chat"
        >
          <MessageCircle className="h-5 w-5" />
        </button>
      )}

      {/* Chat window */}
      {open && (
        <div className="fixed bottom-6 right-6 z-50 flex h-[32rem] w-96 flex-col overflow-hidden rounded-xl border bg-background shadow-2xl">
          {/* Header */}
          <div className="flex h-12 shrink-0 items-center justify-between border-b bg-card px-4">
            <h3 className="text-sm font-semibold">
              {agentId ? `Chat with ${agentName}` : "Chat"}
            </h3>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Message list */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {!agentId && (
              <p className="text-center text-sm text-muted-foreground pt-8">
                Navigate to an agent to start chatting.
              </p>
            )}
            {agentId && messages.length === 0 && !streaming && (
              <p className="text-center text-sm text-muted-foreground pt-8">
                Ask {agentName} anything about the data it watches.
              </p>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={cn(
                  "flex",
                  i >= historyCountRef.current && "animate-chat-bubble",
                  msg.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div className="max-w-[85%] space-y-2">
                  <div
                    className={cn(
                      "rounded-lg px-3 py-2 text-sm",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted",
                    )}
                  >
                    {msg.role === "user" ? (
                      <div className="whitespace-pre-wrap break-words">
                        {msg.content}
                      </div>
                    ) : (
                      <div className="prose prose-sm prose-invert max-w-none break-words prose-p:my-1 prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground prose-a:text-primary prose-headings:text-foreground prose-headings:mt-3 prose-headings:mb-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-hr:my-2 prose-pre:my-1 prose-pre:bg-background/50 prose-code:text-foreground/80">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    )}
                    {msg.role === "assistant" &&
                      !msg.content &&
                      streaming &&
                      i === messages.length - 1 && (
                        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                          <span className="animate-[bounce_1.4s_ease-in-out_infinite]">.</span>
                          <span className="animate-[bounce_1.4s_ease-in-out_0.2s_infinite]">.</span>
                          <span className="animate-[bounce_1.4s_ease-in-out_0.4s_infinite]">.</span>
                        </span>
                      )}
                  </div>

                  {/* Config update proposals */}
                  {msg.configUpdates?.map((update, ui) => (
                    <div
                      key={ui}
                      className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs"
                    >
                      <p className="font-medium text-foreground">
                        Proposed change: {update.description}
                      </p>
                      <p className="mt-1 font-mono text-muted-foreground">
                        {update.field} ={" "}
                        {JSON.stringify(update.value, null, 2).slice(0, 200)}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => handleApplyConfig(update, i)}
                        >
                          Apply Change
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() => handleDismissConfig(update, i)}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Streaming tool status indicator */}
            {currentToolStatus && (
              <div className="flex animate-chat-bubble items-center gap-2 text-xs text-muted-foreground">
                {currentToolStatus.status === "running" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Wrench className="h-3 w-3" />
                )}
                <span>
                  {currentToolStatus.status === "running"
                    ? `Running ${currentToolStatus.name}...`
                    : currentToolStatus.status === "complete"
                      ? `${currentToolStatus.name} completed`
                      : `${currentToolStatus.name} failed`}
                </span>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          {agentId && (
            <div className="shrink-0 border-t p-3">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={handleTextareaChange}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask a question..."
                  rows={1}
                  className="flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <Button
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={handleSend}
                  disabled={!input.trim() || streaming}
                >
                  {streaming ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
