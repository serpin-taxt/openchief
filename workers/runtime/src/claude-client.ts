/**
 * Claude API wrapper using streaming to avoid Cloudflare 524 timeouts.
 * Uses the Anthropic Messages API with SSE streaming, accumulating the
 * response text and token counts from the stream events.
 */

/** Sanitize Unicode: remove lone surrogates that break JSON.stringify */
function sanitizeUnicode(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export async function callClaude(
  apiKey: string,
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  model = "claude-sonnet-4-6",
  maxTokens = 8192,
  _options?: { extendedContext?: boolean }
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }

  if (!response.body) {
    throw new Error("Claude API returned no response body");
  }

  // Read the SSE stream and accumulate text + usage data
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const event = JSON.parse(data) as {
          type: string;
          delta?: { type: string; text?: string };
          message?: { usage?: { input_tokens: number; output_tokens: number } };
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        if (event.type === "content_block_delta" && event.delta?.text) {
          fullText += event.delta.text;
        } else if (event.type === "message_start" && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens || 0;
        } else if (event.type === "message_delta" && event.usage) {
          outputTokens = event.usage.output_tokens || 0;
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  return {
    text: sanitizeUnicode(fullText),
    inputTokens,
    outputTokens,
  };
}
