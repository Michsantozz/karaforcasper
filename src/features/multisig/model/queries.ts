"use client";

/**
 * Camada TanStack Query do fluxo multisig / signature-request.
 *
 * Centraliza as query keys e os hooks para que a invalidação seja consistente
 * cross-component: assinar em /sign/:id invalida a mesma chave que a lista
 * pendente do dashboard consome, então tudo revalida junto sem esperar o
 * próximo tick de polling.
 *
 * Shapes (MyRequest, PendingRequest, RequestDetail, …) espelham o que as rotas
 * /api/signature-requests* devolvem hoje — mantidos aqui como fonte única.
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Tipos das respostas /api (fonte única — antes duplicados nas páginas).
// ---------------------------------------------------------------------------

export interface RequiredSigner {
  publicKeyHex: string;
  label?: string;
}

export interface MyRequest {
  id: string;
  kind: string;
  description: string | null;
  status: string;
  threshold: number;
  requiredSigners: RequiredSigner[];
  transactionHash: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface PendingRequest {
  id: string;
  kind: string;
  description: string | null;
  status: string;
  threshold: number;
  signedCount: number;
  requiredCount: number;
  link: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  type: string;
  message: string;
  requestId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface LinkedWallet {
  id: string;
  publicKeyHex: string;
  label: string | null;
}

export interface RequestDetail {
  id: string;
  kind: string;
  description: string | null;
  status: string;
  chainName: string;
  threshold: number;
  requiredSigners: RequiredSigner[];
  transactionJson: string;
  decoded: { amountCspr: string | null; target: string | null };
  transactionHash: string | null;
  expiresAt: string | null;
  signed: string[];
  pending: string[];
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Query keys — hierárquicas para invalidação por prefixo.
// ---------------------------------------------------------------------------

export const qk = {
  /** Prefixo de tudo que é signature-request; invalida o fluxo inteiro. */
  signatureRequests: ["signature-requests"] as const,
  /** Lista "minhas" com filtro active|all. */
  mine: (filter: "active" | "all") =>
    ["signature-requests", "mine", filter] as const,
  /** Lista "aguardando minha assinatura". */
  pending: ["signature-requests", "pending"] as const,
  /** Detalhe de uma request específica (usado por /sign/:id e /multisig/:id). */
  detail: (id: string) => ["signature-requests", "detail", id] as const,
  notifications: ["notifications"] as const,
  userWallets: ["user-wallets"] as const,
  /** Metadados de uma tx do store (/api/tx/:id) — imutável, cacheável forever. */
  txMeta: (txId: string) => ["tx-meta", txId] as const,
} as const;

// Estados terminais: uma request nesses status não muda mais → para o polling.
const TERMINAL = ["broadcast", "confirmed", "cancelled", "expired"];

export function isTerminal(status: string | undefined): boolean {
  return status !== undefined && TERMINAL.includes(status);
}

// ---------------------------------------------------------------------------
// Fetchers — jogam em cima do fetch nativo, throw em não-ok para o Query
// tratar como erro (em vez de engolir silenciosamente).
// ---------------------------------------------------------------------------

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Detalhe de uma signature-request com polling terminal-aware: enquanto a
 * request não estiver em estado terminal, refaz a cada 5s (outros signatários
 * podem assinar em paralelo). Compartilhada por /sign/:id e /multisig/:id.
 *
 * `enabled` permite a página desligar a query (ex.: sem sessão) sem condicionar
 * a chamada do hook.
 */
export function useRequestDetail(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.detail(id),
    queryFn: () => getJson<RequestDetail>(`/api/signature-requests/${id}`),
    enabled,
    // Polling só enquanto não-terminal. `query.state.data` é o último detalhe.
    refetchInterval: (query) =>
      isTerminal(query.state.data?.status) ? false : 5_000,
  });
}

/** Lista "minhas solicitações" com filtro active|all. */
export function useMyRequests(filter: "active" | "all", enabled = true) {
  const url =
    filter === "active"
      ? "/api/signature-requests?status=pending,ready&limit=100"
      : "/api/signature-requests?limit=100";
  return useQuery({
    queryKey: qk.mine(filter),
    queryFn: () => getJson<{ requests: MyRequest[] }>(url),
    enabled,
    select: (d) => d.requests ?? [],
  });
}

/** Lista "aguardando minha assinatura". */
export function usePendingRequests(enabled = true) {
  return useQuery({
    queryKey: qk.pending,
    queryFn: () =>
      getJson<{ pending: PendingRequest[] }>(
        "/api/signature-requests/pending",
      ),
    enabled,
    select: (d) => d.pending ?? [],
  });
}

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: qk.notifications,
    queryFn: () =>
      getJson<{ notifications: Notification[] }>("/api/notifications"),
    enabled,
    select: (d) => d.notifications ?? [],
  });
}

export function useLinkedWallets(enabled = true) {
  return useQuery({
    queryKey: qk.userWallets,
    queryFn: () => getJson<{ wallets: LinkedWallet[] }>("/api/user-wallets"),
    enabled,
    select: (d) => d.wallets ?? [],
  });
}

/**
 * Metadados de tx do store (/api/tx/:id). O txId é imutável → o dado nunca
 * muda; staleTime Infinity evita qualquer refetch. Retorna só `meta`.
 */
export function useTxMeta<TMeta>(txId: string | undefined) {
  return useQuery({
    queryKey: qk.txMeta(txId ?? "none"),
    queryFn: () => getJson<{ meta: TMeta }>(`/api/tx/${txId}`),
    enabled: Boolean(txId),
    staleTime: Number.POSITIVE_INFINITY,
    select: (d) => d.meta,
  });
}

// ---------------------------------------------------------------------------
// Invalidação — um lugar só, chamado pelas mutations após sucesso.
// ---------------------------------------------------------------------------

/** Revalida o fluxo inteiro (listas + detalhe + notificações + carteiras). */
export function invalidateSignatureFlow(client: QueryClient) {
  void client.invalidateQueries({ queryKey: qk.signatureRequests });
  void client.invalidateQueries({ queryKey: qk.notifications });
  void client.invalidateQueries({ queryKey: qk.userWallets });
}

// ---------------------------------------------------------------------------
// Mutations — cada uma invalida o que muda no sucesso. `variables` tipadas.
// ---------------------------------------------------------------------------

async function postJson(
  url: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Registra assinatura em /sign/:id → invalida detalhe + listas (cross-page). */
export function useApproveRequest(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { signerPublicKeyHex: string; signatureHex: string }) =>
      postJson(`/api/signature-requests/${id}/approve`, vars),
    onSuccess: () => invalidateSignatureFlow(client),
  });
}

export function useBroadcastRequest(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => postJson(`/api/signature-requests/${id}/broadcast`),
    onSuccess: () => invalidateSignatureFlow(client),
  });
}

export function useCancelRequest(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => postJson(`/api/signature-requests/${id}/cancel`),
    onSuccess: () => invalidateSignatureFlow(client),
  });
}

export function useMarkNotificationRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (notifId: string) =>
      postJson(`/api/notifications/${notifId}/read`),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: qk.notifications }),
  });
}
