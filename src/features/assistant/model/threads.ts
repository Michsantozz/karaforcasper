import "server-only";

import { toAISdkMessages } from "@mastra/ai-sdk/ui";
import type { Memory } from "@mastra/memory";

/**
 * Server-side thread store for the chat sidebar (ThreadList). It's a thin
 * façade over the Mastra Memory that backs `assistantAgent` — the SAME PG
 * (schema `mastra`) where the agent persists its messages. So the sidebar and
 * the agent share one source of truth: a thread here IS the agent's memory
 * thread, keyed by the same id.
 *
 * `resourceId` is always the authenticated user id (never a query param) —
 * every read/write is scoped to the caller, so users only ever see their own
 * conversations. Route handlers pass `requireUserId()` in.
 *
 * Archiving isn't a first-class Mastra concept, so we model it in the thread's
 * `metadata.archived` flag and filter on read.
 */

/** Shape the ThreadList sidebar consumes (maps to RemoteThreadMetadata). */
export type ChatThread = {
  id: string;
  title: string | undefined;
  archived: boolean;
  updatedAt: string;
};

/**
 * Resolves the Memory instance that backs `assistantAgent`. Lazy-imports
 * `@/mastra` so route handlers stay light and `next build` doesn't eagerly
 * load the whole agent graph (same pattern as /api/chat).
 */
async function getMemory(): Promise<Memory> {
  const { mastra } = await import("@/mastra");
  const agent = mastra.getAgentById("assistantAgent");
  const memory = await agent.getMemory();
  if (!memory) {
    // Should never happen — the agent is configured with `new Memory(...)`.
    throw new Error("assistantAgent has no memory configured");
  }
  // The agent is built with the concrete `@mastra/memory` Memory, which exposes
  // the resourceId-scoped overloads (getThreadById/recall) the base type omits.
  return memory as Memory;
}

function isArchived(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.archived === true;
}

/** Lists the user's threads, newest first. */
export async function listThreads(userId: string): Promise<ChatThread[]> {
  const memory = await getMemory();
  const { threads } = await memory.listThreads({
    filter: { resourceId: userId },
    // false = no pagination cap; a single user's thread count is small.
    perPage: false,
    orderBy: { field: "updatedAt", direction: "DESC" },
  });
  return threads.map((t) => ({
    id: t.id,
    title: t.title,
    archived: isArchived(t.metadata),
    updatedAt: t.updatedAt.toISOString(),
  }));
}

/**
 * Fetches a single thread's metadata, or null if it doesn't exist / belongs to
 * another user. `getThreadById` scopes by resourceId so cross-user reads
 * return null rather than leaking.
 */
export async function getThread(
  userId: string,
  threadId: string,
): Promise<ChatThread | null> {
  const memory = await getMemory();
  const thread = await memory.getThreadById({ threadId, resourceId: userId });
  if (!thread || thread.resourceId !== userId) return null;
  return {
    id: thread.id,
    title: thread.title,
    archived: isArchived(thread.metadata),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

/**
 * Creates a thread with the client-provided id so the assistant-ui local id and
 * the Mastra thread id stay the same — no id remapping needed. Idempotent:
 * `saveThread` upserts, so re-initializing an existing thread is safe.
 */
export async function createThread(
  userId: string,
  threadId: string,
  title?: string,
): Promise<ChatThread> {
  const memory = await getMemory();
  const thread = await memory.createThread({
    threadId,
    resourceId: userId,
    title,
  });
  return {
    id: thread.id,
    title: thread.title,
    archived: isArchived(thread.metadata),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

/** Renames a thread. Ownership-checked before the write. */
export async function renameThread(
  userId: string,
  threadId: string,
  title: string,
): Promise<void> {
  const memory = await getMemory();
  const existing = await memory.getThreadById({ threadId, resourceId: userId });
  if (!existing || existing.resourceId !== userId) {
    throw new Error("thread not found");
  }
  await memory.updateThread({
    id: threadId,
    title,
    metadata: existing.metadata ?? {},
  });
}

/** Flips the archived flag in metadata (preserving any other metadata). */
export async function setArchived(
  userId: string,
  threadId: string,
  archived: boolean,
): Promise<void> {
  const memory = await getMemory();
  const existing = await memory.getThreadById({ threadId, resourceId: userId });
  if (!existing || existing.resourceId !== userId) {
    throw new Error("thread not found");
  }
  await memory.updateThread({
    id: threadId,
    title: existing.title ?? "",
    metadata: { ...(existing.metadata ?? {}), archived },
  });
}

/** Permanently deletes a thread and its messages. Ownership-checked. */
export async function deleteThread(
  userId: string,
  threadId: string,
): Promise<void> {
  const memory = await getMemory();
  const existing = await memory.getThreadById({ threadId, resourceId: userId });
  if (!existing || existing.resourceId !== userId) {
    throw new Error("thread not found");
  }
  await memory.deleteThread(threadId);
}

/**
 * Loads a thread's message history as AI SDK v6 UIMessages — the exact shape
 * assistant-ui hydrates into the runtime when switching threads. `recall`
 * validates `resourceId`, so this can't read another user's messages.
 */
export async function getThreadMessages(userId: string, threadId: string) {
  const memory = await getMemory();
  const { messages } = await memory.recall({
    threadId,
    resourceId: userId,
    // No pagination cap: return the full history for the thread.
    perPage: false,
  });
  return toAISdkMessages(messages, { version: "v6" });
}
