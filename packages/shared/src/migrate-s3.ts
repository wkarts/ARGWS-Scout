import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const sourceBucket = required("S3_MIGRATION_SOURCE_BUCKET");
const source = new S3Client({
  endpoint: required("S3_MIGRATION_SOURCE_ENDPOINT"),
  region: process.env.S3_MIGRATION_SOURCE_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: required("S3_MIGRATION_SOURCE_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_MIGRATION_SOURCE_SECRET_ACCESS_KEY"),
  },
});
const destination = new S3Client({
  endpoint: required("S3_ENDPOINT"),
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  },
});
const destinationBucket = process.env.S3_BUCKET ?? "scout-artifacts";
const dryRun = process.argv.includes("--dry-run");

function isMissingObject(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const statusCode = Reflect.get(error, "$metadata")?.httpStatusCode;
  return (
    statusCode === 404 ||
    ["NotFound", "NoSuchKey", "NotFoundException"].includes(error.name)
  );
}

async function isAlreadyMigrated(
  key: string,
  size: number,
  expectedSha256?: string,
): Promise<boolean> {
  try {
    const head = await destination.send(
      new HeadObjectCommand({ Bucket: destinationBucket, Key: key }),
    );
    return (
      head.ContentLength === size &&
      typeof head.Metadata?.sha256 === "string" &&
      expectedSha256 !== undefined &&
      head.Metadata.sha256 === expectedSha256
    );
  } catch (error) {
    if (isMissingObject(error)) return false;
    throw error;
  }
}

let continuationToken: string | undefined;
let inspected = 0;
let pending = 0;
let copied = 0;
let skipped = 0;
let bytesCopied = 0;

do {
  const page = await source.send(
    new ListObjectsV2Command({
      Bucket: sourceBucket,
      ContinuationToken: continuationToken,
    }),
  );

  for (const object of page.Contents ?? []) {
    if (!object.Key || object.Size === undefined) continue;
    inspected += 1;
    const sourceHead = await source.send(
      new HeadObjectCommand({ Bucket: sourceBucket, Key: object.Key }),
    );
    if (sourceHead.ContentLength !== object.Size)
      throw new Error("Source object size changed during migration.");
    const sourceSha256 = sourceHead.Metadata?.sha256;
    if (await isAlreadyMigrated(object.Key, object.Size, sourceSha256)) {
      skipped += 1;
      continue;
    }
    pending += 1;
    if (dryRun) continue;

    const original = await source.send(
      new GetObjectCommand({ Bucket: sourceBucket, Key: object.Key }),
    );
    if (!original.Body)
      throw new Error("Source object returned an empty response body.");
    await destination.send(
      new PutObjectCommand({
        Bucket: destinationBucket,
        Key: object.Key,
        Body: original.Body as Readable,
        ContentLength: original.ContentLength ?? object.Size,
        ContentType: original.ContentType,
        CacheControl: original.CacheControl,
        ContentDisposition: original.ContentDisposition,
        ContentEncoding: original.ContentEncoding,
        ContentLanguage: original.ContentLanguage,
        Expires: original.Expires,
        Metadata: original.Metadata,
      }),
    );

    const verification = await destination.send(
      new HeadObjectCommand({ Bucket: destinationBucket, Key: object.Key }),
    );
    if (
      verification.ContentLength !== object.Size ||
      (sourceSha256 !== undefined &&
        verification.Metadata?.sha256 !== sourceSha256)
    )
      throw new Error("Destination object size verification failed.");
    copied += 1;
    bytesCopied += object.Size;
  }

  continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (continuationToken);

console.log(
  JSON.stringify(
    { dryRun, inspected, pending, copied, skipped, bytesCopied },
    null,
    2,
  ),
);
