import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { uploadObject } from "@/server/storage/s3";
import { checkRateLimit, rateLimitedResponse } from "@/shared/lib/rate-limit";

// Image formats the vision model (Fireworks kimi) accepts, plus PDF for docs.
const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Uploads a chat attachment to object storage (MinIO/S3) and returns its public
 * URL. The client (assistant-ui attachment adapter) calls this before sending
 * the message; the returned URL becomes the image/file part the agent sees.
 *
 * Auth-gated: uploads cost storage and the object key is namespaced by the
 * session user — never trust a user id from the body.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Per-user rate limit: uploads cost storage and each one can be up to 10 MB.
  // 30 / 60s bounds abuse without getting in the way of a normal chat session.
  const rl = await checkRateLimit({
    key: `upload:${session.user.id}`,
    window: 60,
    max: 30,
  });
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }

  const contentType = file.type || "application/octet-stream";
  if (!ALLOWED.has(contentType)) {
    return NextResponse.json(
      { error: `unsupported type: ${contentType}` },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }

  const body = Buffer.from(await file.arrayBuffer());
  try {
    const uploaded = await uploadObject({
      userId: session.user.id,
      filename: file.name || "upload",
      contentType,
      body,
    });
    return NextResponse.json(uploaded);
  } catch (err) {
    console.error("[upload] failed:", err);
    return NextResponse.json({ error: "upload failed" }, { status: 500 });
  }
}
