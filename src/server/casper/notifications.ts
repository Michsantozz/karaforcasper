import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/shared/db";
import { notifications, type NotificationRow } from "@/shared/db/schema";

/**
 * In-app notifications for the multisig flow.
 *
 * Created when a request is opened (notifies each signer who has an account)
 * and when its state changes (ready/broadcast). No external transport (email)
 * for now — just in-app, read via the /multisig dashboard bell icon.
 */

export type NotificationType =
  | "signature_requested"
  | "request_ready"
  | "request_broadcast"
  | "request_cancelled"
  // Meeting minutes generated automatically after the call ends (bot webhook).
  | "meeting_summary_ready";

/** Creates a notification for a user. */
export async function createNotification(input: {
  userId: string;
  type: NotificationType;
  message: string;
  requestId?: string | null;
}): Promise<void> {
  await db.insert(notifications).values({
    id: randomUUID(),
    userId: input.userId,
    type: input.type,
    message: input.message,
    requestId: input.requestId ?? null,
  });
}

/**
 * Creates the same notification for several users at once (e.g.: notifying
 * all signers who have an account when a request is opened). Ignores an empty list.
 */
export async function createNotificationsForUsers(input: {
  userIds: string[];
  type: NotificationType;
  message: string;
  requestId?: string | null;
}): Promise<void> {
  const unique = Array.from(new Set(input.userIds));
  if (unique.length === 0) return;

  await db.insert(notifications).values(
    unique.map((userId) => ({
      id: randomUUID(),
      userId,
      type: input.type,
      message: input.message,
      requestId: input.requestId ?? null,
    })),
  );
}

/** A user's notifications, most recent first. */
export async function listNotifications(
  userId: string,
  opts?: { unreadOnly?: boolean; limit?: number },
): Promise<NotificationRow[]> {
  const where = opts?.unreadOnly
    ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
    : eq(notifications.userId, userId);

  return db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(opts?.limit ?? 50);
}

/**
 * Marks a notification as read. Restricted to the owner (userId) so a user
 * can't mark another user's notification.
 */
export async function markNotificationRead(
  notificationId: string,
  userId: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
      ),
    );
}

/** Marks all of a user's unread notifications as read. */
export async function markAllNotificationsRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.readAt)),
    );
}
