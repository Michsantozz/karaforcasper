import "server-only";
import { Buffer } from "node:buffer";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";

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
