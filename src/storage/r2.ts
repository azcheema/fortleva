import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { R2Config } from "@/config";

import {
  assertStorageKey,
  type HeadResult,
  type PresignGetOptions,
  type PresignPutOptions,
  type PresignedPut,
  type StorageTransport,
} from "./transport";

/**
 * Cloudflare R2 (EU jurisdiction) over the S3 API (SECURITY.md §5,
 * ARC-01). R2 has no presigned POST — hence no content-length-range
 * policy — so Content-Length and Content-Type are signed INTO the PUT
 * URL and the service HEAD-verifies the real size before committing.
 * Downloads: response-content-disposition=attachment, always.
 */
export class R2Transport implements StorageTransport {
  readonly name = "r2" as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: R2Config) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: cfg.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut> {
    assertStorageKey(key);
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
    });
    // signableHeaders forces both into the signature so a mismatching
    // upload is rejected by R2 itself.
    const url = await getSignedUrl(this.client, cmd, {
      expiresIn: opts.expiresSec,
      signableHeaders: new Set(["content-type", "content-length"]),
    });
    return {
      url,
      headers: {
        "Content-Type": opts.contentType,
        "Content-Length": String(opts.contentLength),
      },
    };
  }

  async head(key: string): Promise<HeadResult | null> {
    assertStorageKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: Number(res.ContentLength ?? 0), etag: res.ETag };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (e as { name?: string }).name;
      if (status === 404 || name === "NotFound" || name === "NoSuchKey") return null;
      throw e;
    }
  }

  async presignGet(key: string, opts: PresignGetOptions): Promise<string> {
    assertStorageKey(key);
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: opts.responseContentDisposition,
      ResponseContentType: opts.responseContentType,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: opts.expiresSec });
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    assertStorageKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    assertStorageKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return await res.Body.transformToByteArray();
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (e as { name?: string }).name;
      if (status === 404 || name === "NotFound" || name === "NoSuchKey") return null;
      throw e;
    }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    assertStorageKey(key);
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
    );
  }
}
