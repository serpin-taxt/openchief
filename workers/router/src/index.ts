import type { OpenChiefEvent } from "@openchief/shared";
import { routeEvents } from "./router";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  X_BEARER_TOKEN?: string;
}

export default {
  /**
   * Queue consumer — receives batches of OpenChiefEvents from connectors.
   */
  async queue(
    batch: MessageBatch<OpenChiefEvent>,
    env: Env
  ): Promise<void> {
    const events = batch.messages.map((msg) => msg.body);
    console.log(`Processing batch of ${events.length} events`);

    await routeEvents(events, env);
  },

  /**
   * HTTP handler for health checks.
   */
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return Response.json({
      service: "openchief-router",
      status: "ok",
    });
  },
};
