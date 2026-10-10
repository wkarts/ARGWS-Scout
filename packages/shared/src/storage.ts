import { randomUUID, createHash } from "node:crypto";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const region = process.env.S3_REGION ?? "us-east-1";
const bucket = process.env.S3_BUCKET ?? "scout-artifacts";
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  },
});
let bucketReady: Promise<void> | null = null;

async function ensureBucket(): Promise<void> {
  if (!bucketReady)
    bucketReady = (async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        try {
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/BucketAlreadyOwnedByYou|BucketAlreadyExists/i.test(
              `${error.name} ${error.message}`,
            )
          )
            throw error;
        }
      }
    })();
  // A transient unavailable backend must be retried on next readiness check.
  return bucketReady.catch((error) => {
    bucketReady = null;
    throw error;
  });
}

export async function checkObjectStorage(): Promise<void> {
  if (
    !process.env.S3_ENDPOINT ||
    !process.env.S3_ACCESS_KEY_ID ||
    !process.env.S3_SECRET_ACCESS_KEY
  )
    throw new Error("Armazenamento de objetos não configurado.");
  await ensureBucket();
}

export async function storeArtifact(input: {
  tenantId: string;
  jobId: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
}): Promise<{
  id: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}> {
  if (
    !process.env.S3_ENDPOINT ||
    !process.env.S3_ACCESS_KEY_ID ||
    !process.env.S3_SECRET_ACCESS_KEY
  )
    throw new Error("Object storage não configurado.");
  await ensureBucket();
  const id = randomUUID();
  const objectKey = `${input.tenantId}/${input.jobId}/${id}-${input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: input.bytes,
      ContentType: input.contentType,
      Metadata: { sha256: digest, tenant: input.tenantId, job: input.jobId },
    }),
  );
  return { id, objectKey, sha256: digest, sizeBytes: input.bytes.byteLength };
}

export async function getArtifactStream(objectKey: string) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
  );
  if (!response.Body)
    throw new Error("Arquivo de resultado não encontrado no armazenamento.");
  return response;
}
