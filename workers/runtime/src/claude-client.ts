/**
 * Simple Claude API wrapper.
 * Calls the Anthropic Messages API and returns the text + token counts.
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
  maxTokens = 8192
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }

  const result = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const text = result.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => sanitizeUnicode(b.text!))
    .join("");

  return {
    text,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
  };
}
