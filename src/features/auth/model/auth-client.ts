"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

/**
 * Client do better-auth (browser).
 *
 * SEM baseURL fixo de propósito: better-auth usa a ORIGEM ATUAL (relativo). Fixar
 * NEXT_PUBLIC_APP_URL (domínio público) quebrava com CORS ao acessar por outra
 * origem (ex.: localhost:3009 no dev batendo no domínio do túnel). Relativo
 * funciona em qualquer host — localhost, túnel e produção.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});

export const { signIn, signOut, useSession } = authClient;
