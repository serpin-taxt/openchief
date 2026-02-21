import type { AgentReport } from "@openchief/shared";

// ─── Types ──────────────────────────────────────────────────────────────

interface Env {
  VECTORIZE: VectorizeIndex;
  AI: Ai;
}

interface InboxEvent {
  timestamp: string;
  source: string;
  event_type: string;
  summary: string;
  payload: string;
}

// ─── Embedding ──────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

async function embedText(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run(EMBEDDING_MODEL, { text: [text] }) as {
    data: number[][];
  };
  return result.data[0];
}

async function embedTexts(ai: Ai, texts: string[]): Promise<number[][]> {
  // Workers AI supports batching up to ~100 texts
  const result = await ai.run(EMBEDDING_MODEL, { text: texts }) as {
    data: number[][];
  };
  return result.data;
}

// ─── Truncation Helper ──────────────────────────────────────────────────

/** Truncate text to roughly `maxChars` characters (approximate token budget). */
function truncate(text: string, maxChars: number = 2000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
}

// ─── Index Reports ──────────────────────────────────────────────────────

/**
 * Index a report's headline and each section as separate vectors.
 * Called via ctx.waitUntil() so it doesn't block report generation.
 */
export async function indexReport(
  env: Env,
  agentId: string,
  report: AgentReport
): Promise<void> {
  const texts: string[] = [];
  const ids: string[] = [];
  const metadatas: Record<string, string>[] = [];

  // Vector for the headline + action items
  const headlineText = `${report.content.headline}\n\nAction items: ${
    report.content.actionItems
      .map((a) => `[${a.priority}] ${a.description}`)
      .join("; ") || "none"
  }`;
  texts.push(truncate(headlineText));
  ids.push(`report:${report.id}:headline`);
  metadatas.push({
    agentId,
    reportId: report.id,
    reportType: report.reportType,
    createdAt: report.createdAt,
    type: "report-headline",
    health: report.content.healthSignal,
  });

  // Vector per section
  for (let i = 0; i < report.content.sections.length; i++) {
    const section = report.content.sections[i];
    const sectionText = `${report.content.headline} — ${section.name}: ${section.body}`;
    texts.push(truncate(sectionText));
    ids.push(`report:${report.id}:s${i}`);
    metadatas.push({
      agentId,
      reportId: report.id,
      reportType: report.reportType,
      createdAt: report.createdAt,
      type: "report-section",
      sectionName: section.name,
      severity: section.severity,
    });
  }

  if (texts.length === 0) return;

  // Embed all texts in a single batch
  const embeddings = await embedTexts(env.AI, texts);

  // Build VectorizeVector objects
  const vectors: VectorizeVector[] = embeddings.map((values, i) => ({
    id: ids[i],
    values,
    metadata: metadatas[i],
  }));

  // Upsert in batches of 100 (Vectorize limit)
  for (let i = 0; i < vectors.length; i += 100) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 100));
  }
}

// ─── Index Events ───────────────────────────────────────────────────────

/**
 * Index processed events as batched summaries.
 * Groups ~20 event summaries per vector to keep the index manageable.
 */
export async function indexEvents(
  env: Env,
  agentId: string,
  events: InboxEvent[]
): Promise<void> {
  if (events.length === 0) return;

  const BATCH_SIZE = 20;
  const texts: string[] = [];
  const ids: string[] = [];
  const metadatas: Record<string, string | number>[] = [];

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const batchText = batch
      .map((e) => `[${e.timestamp}] ${e.event_type}: ${e.summary}`)
      .join("\n");

    texts.push(truncate(batchText));

    const startDate = batch[0].timestamp;
    const endDate = batch[batch.length - 1].timestamp;
    ids.push(`events:${agentId}:${startDate}`);
    metadatas.push({
      agentId,
      type: "event-batch",
      startDate,
      endDate,
      eventCount: batch.length,
    });
  }

  // Embed all batches
  const embeddings = await embedTexts(env.AI, texts);

  const vectors: VectorizeVector[] = embeddings.map((values, i) => ({
    id: ids[i],
    values,
    metadata: metadatas[i],
  }));

  // Upsert in batches of 100
  for (let i = 0; i < vectors.length; i += 100) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 100));
  }
}

// ─── Retrieve Context ───────────────────────────────────────────────────

/**
 * Retrieve relevant historical context for a query.
 * Returns a formatted string block ready to inject into prompts.
 */
export async function retrieveContext(
  env: Env,
  agentId: string,
  query: string,
  topK: number = 10
): Promise<string> {
  try {
    const queryVector = await embedText(env.AI, query);

    const results = await env.VECTORIZE.query(queryVector, {
      topK,
      filter: { agentId },
      returnMetadata: "all",
    });

    if (!results.matches || results.matches.length === 0) {
      return "";
    }

    const lines: string[] = [];

    for (const match of results.matches) {
      const meta = match.metadata as Record<string, string> | undefined;
      if (!meta) continue;

      const score = match.score?.toFixed(3) ?? "?";
      const date = meta.createdAt || meta.startDate || "unknown date";
      const shortDate = date.slice(0, 10); // YYYY-MM-DD

      if (meta.type === "report-headline") {
        lines.push(
          `[${shortDate}] (${meta.reportType}, health: ${meta.health}, relevance: ${score}) ${meta.reportId}`
        );
      } else if (meta.type === "report-section") {
        lines.push(
          `[${shortDate}] (${meta.reportType} > ${meta.sectionName}, ${meta.severity}, relevance: ${score})`
        );
      } else if (meta.type === "event-batch") {
        lines.push(
          `[${shortDate}] (${meta.eventCount} events, relevance: ${score})`
        );
      }
    }

    if (lines.length === 0) return "";

    return `HISTORICAL CONTEXT (from long-term memory):\n${lines.join("\n")}`;
  } catch (err) {
    console.error("RAG retrieval error:", err);
    return "";
  }
}

// ─── Backfill Helper ────────────────────────────────────────────────────

/**
 * Backfill existing reports from D1 into Vectorize.
 * Called from the admin endpoint.
 */
export async function backfillReports(
  env: Env & { DB: D1Database }
): Promise<{ indexed: number; errors: number }> {
  const rows = await env.DB.prepare(
    `SELECT id, agent_id, report_type, content, event_count, created_at
     FROM reports ORDER BY created_at ASC`
  )
    .all();

  let indexed = 0;
  let errors = 0;

  for (const row of rows.results) {
    try {
      const content = JSON.parse(row.content as string);
      const report: AgentReport = {
        id: row.id as string,
        agentId: row.agent_id as string,
        reportType: row.report_type as string,
        content,
        eventCount: row.event_count as number,
        createdAt: row.created_at as string,
      };

      await indexReport(env, report.agentId, report);
      indexed++;
    } catch (err) {
      console.error(`Failed to index report ${row.id}:`, err);
      errors++;
    }
  }

  return { indexed, errors };
}
