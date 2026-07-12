import "server-only";
import { Buffer } from "node:buffer";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "@/shared/lib/logger";

const log = createLogger("s3");

/**
 * Object storage for chat attachments (MinIO in docker-compose, any S3-compat
 * endpoint in prod). Server-only: the S3 credentials must never reach the
 * client bundle. The browser talks to `/api/upload`, never to S3 directly.
 *
 * Public read: the bucket is provisioned with anonymous download (see
 * `minio-init` in docker-compose), so the returned URL is fetchable by both the
 * browser preview and the vision model. If you switch to a private bucket,
 * return a presigned GET URL from here instead of the plain public URL.
 */

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;
  const accessKeyId = env("S3_ACCESS_KEY_ID");
  const secretAccessKey = env("S3_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Storage not configured: S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY missing.");
  }
  client = new S3Client({
    region: env("S3_REGION") ?? "us-east-1",
    // Omit endpoint for real AWS S3; set for MinIO/R2 (S3_ENDPOINT).
    ...(env("S3_ENDPOINT") ? { endpoint: env("S3_ENDPOINT") } : {}),
    // Path-style is required by MinIO and R2; AWS S3 uses virtual-hosted style.
    forcePathStyle: env("S3_FORCE_PATH_STYLE") === "true",
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

function bucket(): string {
  const b = env("S3_BUCKET");
  if (!b) throw new Error("Storage not configured: S3_BUCKET missing.");
  return b;
}

/** Public base URL objects are served from (browser + vision model fetch here). */
function publicBase(): string {
  const explicit = env("S3_PUBLIC_URL");
  if (explicit) return explicit.replace(/\/$/, "");
  // Fallback: derive from endpoint + bucket (path-style).
  const endpoint = env("S3_ENDPOINT");
  if (endpoint) return `${endpoint.replace(/\/$/, "")}/${bucket()}`;
  throw new Error("Storage not configured: S3_PUBLIC_URL or S3_ENDPOINT required.");
}

/**
 * Internal base URL the *server* reaches the object store at (path-style,
 * bucket included). In compose this is `http://minio:9000/<bucket>` — reachable
 * over the internal network — while the persisted public URL is
 * `http://localhost:9200/<bucket>`, which only the host/browser can resolve.
 * Returns null when no endpoint is configured (real AWS S3: public URL is
 * already server-reachable).
 */
function internalBase(): string | null {
  const endpoint = env("S3_ENDPOINT");
  if (!endpoint) return null;
  return `${endpoint.replace(/\/$/, "")}/${bucket()}`;
}

/**
 * Rewrites a persisted public object URL to one the server can fetch. A stored
 * meeting `videoUrl` is `S3_PUBLIC_URL/...` (host-facing, e.g. localhost:9200);
 * when the same-origin proxy fetches it from *inside* the container, that host
 * is unreachable, so we swap the public base for the internal endpoint base.
 * URLs that don't start with our public base (e.g. Recall's signed CDN URLs)
 * pass through untouched.
 */
export function toServerReachableUrl(url: string): string {
  const publicUrl = env("S3_PUBLIC_URL");
  const internal = internalBase();
  if (!publicUrl || !internal) return url;
  const base = publicUrl.replace(/\/$/, "");
  return url.startsWith(base) ? internal + url.slice(base.length) : url;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

function keyFor(userId: string, filename: string, contentType: string): string {
  const dot = filename.lastIndexOf(".");
  const fromName = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  const ext = fromName || EXT_BY_MIME[contentType] || "bin";
  // Namespace by user so listings/cleanup stay per-owner; uuid avoids collisions.
  return `uploads/${userId}/${uuidv4()}.${ext}`;
}

export type UploadedObject = {
  url: string;
  key: string;
  contentType: string;
};

/**
 * Uploads bytes and returns the public URL. `userId` scopes the object key to
 * the owner (never trust a path from the client).
 */
export async function uploadObject(input: {
  userId: string;
  filename: string;
  contentType: string;
  body: Buffer | Uint8Array;
}): Promise<UploadedObject> {
  const key = keyFor(input.userId, input.filename, input.contentType);
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
  return { url: `${publicBase()}/${key}`, key, contentType: input.contentType };
}

/**
 * Deletes a stored object by its persisted public URL. Best-effort: used when a
 * meeting is deleted, to reclaim the durable video/attachment bytes. Returns
 * true if the delete was issued, false if the URL isn't one of ours (foreign
 * host, e.g. a Recall signed URL) or storage isn't configured. Never throws —
 * storage failures must not block the record delete.
 */
export async function deleteObjectByUrl(url: string): Promise<boolean> {
  const key = keyFromPublicUrl(url);
  if (!key) return false;
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
    );
    return true;
  } catch (err) {
    log.error({ err, url }, "delete failed");
    return false;
  }
}

/**
 * Extracts the object key from a persisted public URL (`<publicBase>/<key>`).
 * Returns null when the URL doesn't live under our public base — a foreign host
 * (Recall's signed CDN URL) must never be handed to a DeleteObject on our bucket.
 */
function keyFromPublicUrl(url: string): string | null {
  let base: string;
  try {
    base = publicBase();
  } catch {
    return null;
  }
  const prefix = `${base}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}
