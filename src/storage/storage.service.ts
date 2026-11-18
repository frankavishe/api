import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

/** S3-compatible object storage (MinIO in development). */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly s3: S3Client;

  constructor(config: ConfigService<Env, true>) {
    this.s3 = new S3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
      },
    });
  }

  async put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  /** Returns null if the object does not exist. */
  async get(bucket: string, key: string): Promise<{ body: Readable; contentType?: string } | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { body: res.Body as Readable, contentType: res.ContentType };
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  async delete(bucket: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.s3.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }),
    );
  }

  onModuleDestroy() {
    this.s3.destroy();
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
