import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Neon branchable object storage (S3-compatible). PRIVATE bucket only: every read needs the
 * server-held credential. Keys live under `jobs/<jobId>/<kind>...`.
 */
export interface NeonStorageConfig { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }

export function neonStorageConfigFromEnv(env: Record<string, string | undefined> = process.env): NeonStorageConfig | null {
  const endpoint = env.NEON_STORAGE_ENDPOINT, bucket = env.NEON_STORAGE_BUCKET;
  const accessKeyId = env.NEON_STORAGE_ACCESS_KEY_ID, secretAccessKey = env.NEON_STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: env.NEON_STORAGE_REGION || "us-east-2" };
}

const JOB_KEY = /^jobs\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;
/** Guards against path tricks: only keys of the exact shape we write are accepted. */
export function assertJobKey(key: string): void {
  if (!JOB_KEY.test(key) || key.includes("..")) throw new Error("Invalid artifact key");
}

let cached: { cfgKey: string; client: S3Client } | null = null;
function clientFor(cfg: NeonStorageConfig, override?: S3Client): S3Client {
  if (override) return override;
  const cfgKey = JSON.stringify(cfg);
  if (cached?.cfgKey === cfgKey) return cached.client;
  const opts: S3ClientConfig = {
    region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  };
  const client = new S3Client(opts);
  cached = { cfgKey, client };
  return client;
}

function resolve(cfg?: NeonStorageConfig | null) {
  const c = cfg ?? neonStorageConfigFromEnv();
  if (!c) throw new Error("Neon storage is not configured (NEON_STORAGE_*)");
  return c;
}

export async function neonPut(
  key: string, body: string | Uint8Array, contentType: string,
  opts: { cfg?: NeonStorageConfig; client?: S3Client } = {},
): Promise<void> {
  assertJobKey(key);
  const cfg = resolve(opts.cfg);
  await clientFor(cfg, opts.client).send(new PutObjectCommand({
    Bucket: cfg.bucket, Key: key, Body: typeof body === "string" ? Buffer.from(body) : body, ContentType: contentType,
  }));
}

export interface NeonObject { stream: ReadableStream<Uint8Array>; contentType: string; size: number }

export async function neonGet(
  key: string, opts: { cfg?: NeonStorageConfig; client?: S3Client } = {},
): Promise<NeonObject | null> {
  assertJobKey(key);
  const cfg = resolve(opts.cfg);
  try {
    const res = await clientFor(cfg, opts.client).send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    if (!res.Body) return null;
    return {
      stream: res.Body.transformToWebStream() as ReadableStream<Uint8Array>,
      contentType: res.ContentType ?? "application/octet-stream",
      size: res.ContentLength ?? 0,
    };
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function neonDelete(key: string, opts: { cfg?: NeonStorageConfig; client?: S3Client } = {}): Promise<void> {
  assertJobKey(key);
  const cfg = resolve(opts.cfg);
  await clientFor(cfg, opts.client).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

/** Short-lived (<=60s) download URL. Call ONLY after the ownership check; streaming is preferred. */
export async function neonPresignGet(key: string, seconds = 60, opts: { cfg?: NeonStorageConfig; client?: S3Client } = {}): Promise<string> {
  assertJobKey(key);
  const cfg = resolve(opts.cfg);
  return getSignedUrl(clientFor(cfg, opts.client), new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: Math.min(seconds, 60) });
}
