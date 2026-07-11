import "server-only";
import { headers } from "next/headers";
import { auth } from "@/features/auth/model/auth";

/**
 * Resolves the current session server-side (routes/RSC/tools).
 *
 * Replaces the hardcoded `user_id`: the calendar and bots belong to the
 * authenticated user. Tools and routes derive the user_id from here, never
 * from a query param.
 */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/** Session user_id, or throws if unauthenticated. Use in protected routes. */
export async function requireUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new Error("unauthenticated");
  }
  return session.user.id;
}
