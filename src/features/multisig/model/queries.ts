"use client";

/**
 * TanStack Query layer for the multisig / signature-request flow.
 *
 * Centralizes the query keys and hooks so invalidation stays consistent
 * cross-component: signing at /sign/:id invalidates the same key that the
 * dashboard's pending list consumes, so everything revalidates together
 * without waiting for the next polling tick.
 *
 * Shapes (MyRequest, PendingRequest, RequestDetail, …) mirror what the
 * /api/signature-requests* routes return today — kept here as the single source.
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Types for the /api responses (single source — previously duplicated across pages).
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
// Query keys — hierarchical for prefix-based invalidation.
// ---------------------------------------------------------------------------

export const qk = {
  /** Prefix for everything signature-request related; invalidates the whole flow. */
  signatureRequests: ["signature-requests"] as const,
  /** "Mine" list with active|all filter. */
  mine: (filter: "active" | "all") =>
    ["signature-requests", "mine", filter] as const,
  /** "Awaiting my signature" list. */
  pending: ["signature-requests", "pending"] as const,
  /** Detail of a specific request (used by /sign/:id and /multisig/:id). */
  detail: (id: string) => ["signature-requests", "detail", id] as const,
  notifications: ["notifications"] as const,
  userWallets: ["user-wallets"] as const,
  /** Metadata of a tx from the store (/api/tx/:id) — immutable, cacheable forever. */
  txMeta: (txId: string) => ["tx-meta", txId] as const,
} as const;

// Terminal states: a request in these statuses no longer changes → stop polling.
const TERMINAL = ["broadcast", "confirmed", "cancelled", "expired"];

export function isTerminal(status: string | undefined): boolean {
  return status !== undefined && TERMINAL.includes(status);
}

// ---------------------------------------------------------------------------
// Fetchers — wrap the native fetch, throw on not-ok so Query treats it as an
// error (instead of swallowing it silently).
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
 * Detail of a signature-request with terminal-aware polling: while the
 * request isn't in a terminal state, refetches every 5s (other signers may
 * sign in parallel). Shared by /sign/:id and /multisig/:id.
 *
 * `enabled` lets the page turn off the query (e.g. no session) without
 * conditioning the hook call.
 */
export function useRequestDetail(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.detail(id),
    queryFn: () => getJson<RequestDetail>(`/api/signature-requests/${id}`),
    enabled,
    // Polling only while non-terminal. `query.state.data` is the latest detail.
    refetchInterval: (query) =>
      isTerminal(query.state.data?.status) ? false : 5_000,
  });
}

/** "My requests" list with active|all filter. */
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

/** "Awaiting my signature" list. */
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
 * Tx metadata from the store (/api/tx/:id). txId is immutable → the data
 * never changes; staleTime Infinity avoids any refetch. Returns only `meta`.
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
// Invalidation — a single place, called by mutations after success.
// ---------------------------------------------------------------------------

/** Revalidates the whole flow (lists + detail + notifications + wallets). */
export function invalidateSignatureFlow(client: QueryClient) {
  void client.invalidateQueries({ queryKey: qk.signatureRequests });
  void client.invalidateQueries({ queryKey: qk.notifications });
  void client.invalidateQueries({ queryKey: qk.userWallets });
}

// ---------------------------------------------------------------------------
// Mutations — each one invalidates what changes on success. Typed `variables`.
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

/** Registers a signature at /sign/:id → invalidates detail + lists (cross-page). */
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
