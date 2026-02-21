/**
 * Intercom REST API client for polling conversations and tickets.
 *
 * Uses the Intercom API v2.11 with bearer token auth.
 * Docs: https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations
 */

const INTERCOM_API_BASE = "https://api.intercom.io";

interface IntercomRequestOptions {
  path: string;
  method?: string;
  token: string;
  body?: unknown;
  params?: Record<string, string>;
}

async function intercomFetch<T>(opts: IntercomRequestOptions): Promise<T> {
  const url = new URL(opts.path, INTERCOM_API_BASE);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Intercom-Version": "2.11",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Intercom API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// --- Types -------------------------------------------------------------------

export interface IntercomConversation {
  type: "conversation";
  id: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  state: "open" | "closed" | "snoozed";
  open: boolean;
  read: boolean;
  waiting_since: number | null;
  snoozed_until: number | null;
  priority: "priority" | "not_priority";
  source: {
    type: string;
    id: string;
    delivered_as: string;
    subject: string;
    body: string;
    author: {
      type: string;
      id: string;
      name: string | null;
      email: string | null;
    };
    url: string | null;
  };
  contacts: {
    type: "contact.list";
    contacts: Array<{
      type: string;
      id: string;
      external_id: string | null;
    }>;
  };
  assignee: {
    type: string;
    id: string | null;
    name: string | null;
    email: string | null;
  } | null;
  conversation_rating: {
    rating: number;
    remark: string | null;
    created_at: number;
    contact: { type: string; id: string } | null;
  } | null;
  tags: {
    type: "tag.list";
    tags: Array<{ type: string; id: string; name: string }>;
  };
  statistics: {
    type: "conversation_statistics";
    time_to_assignment: number | null;
    time_to_admin_reply: number | null;
    time_to_first_close: number | null;
    time_to_last_close: number | null;
    median_time_to_reply: number | null;
    first_contact_reply_at: number | null;
    first_assignment_at: number | null;
    first_admin_reply_at: number | null;
    first_close_at: number | null;
    last_assignment_at: number | null;
    last_close_at: number | null;
    last_contact_reply_at: number | null;
    last_admin_reply_at: number | null;
    count_reopens: number | null;
    count_assignments: number | null;
    count_conversation_parts: number | null;
  } | null;
}

export interface IntercomConversationList {
  type: "conversation.list";
  conversations: IntercomConversation[];
  total_count: number;
  pages: {
    type: "pages";
    page: number;
    per_page: number;
    total_pages: number;
    next?: { page: number; starting_after: string };
  };
}

export interface IntercomConversationPart {
  type: "conversation_part";
  id: string;
  part_type: string;
  body: string | null;
  created_at: number;
  updated_at: number;
  author: {
    type: string;
    id: string;
    name: string | null;
    email: string | null;
  };
}

export interface IntercomConversationDetail extends IntercomConversation {
  conversation_parts: {
    type: "conversation_part.list";
    conversation_parts: IntercomConversationPart[];
    total_count: number;
  };
}

// --- API Methods -------------------------------------------------------------

/**
 * Search conversations updated after a given timestamp.
 */
export async function searchConversations(
  token: string,
  updatedAfter: number,
  page?: string
): Promise<IntercomConversationList> {
  const body: Record<string, unknown> = {
    query: {
      field: "updated_at",
      operator: ">",
      value: updatedAfter,
    },
    sort: {
      field: "updated_at",
      order: "desc",
    },
    pagination: {
      per_page: 20,
      ...(page ? { starting_after: page } : {}),
    },
  };

  return intercomFetch<IntercomConversationList>({
    path: "/conversations/search",
    method: "POST",
    token,
    body,
  });
}

/**
 * Get a single conversation with all parts (messages/notes).
 */
export async function getConversation(
  token: string,
  conversationId: string
): Promise<IntercomConversationDetail> {
  return intercomFetch<IntercomConversationDetail>({
    path: `/conversations/${conversationId}`,
    token,
    params: { display_as: "plaintext" },
  });
}

/**
 * Get the Intercom app identity (workspace name, etc.)
 */
export async function getAppIdentity(
  token: string
): Promise<{ app_id: string; name: string }> {
  const data = await intercomFetch<Record<string, unknown>>({
    path: "/me",
    token,
  });
  return {
    app_id: (data.app as Record<string, unknown>)?.id_code as string || "unknown",
    name: (data.app as Record<string, unknown>)?.name as string || "Intercom",
  };
}
