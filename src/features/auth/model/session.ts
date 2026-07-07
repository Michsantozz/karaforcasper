import { headers } from "next/headers";
import { auth } from "@/features/auth/model/auth";

/**
 * Resolve a sessão atual server-side (rotas/RSC/tools).
 *
 * Substitui o `user_id` hardcoded: o dono da agenda e dos bots é o usuário
 * autenticado. Tools e rotas derivam o user_id daqui, nunca de query param.
 */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/** user_id da sessão, ou lança se não autenticado. Use em rotas protegidas. */
export async function requireUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new Error("unauthenticated");
  }
  return session.user.id;
}
