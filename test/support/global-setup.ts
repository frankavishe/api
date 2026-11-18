import { execFileSync } from 'node:child_process';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    DATABASE_URL: string;
    REDIS_URL: string;
    S3_ENDPOINT: string;
  }
}

export const MINIO_USER = 'testminio';
export const MINIO_PASSWORD = 'testminio-secret';

let pg: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;
let minio: StartedTestContainer;

/** Starts real infrastructure once for the whole e2e run (constitution III). */
export async function setup(project: TestProject) {
  [pg, redis, minio] = await Promise.all([
    new PostgreSqlContainer('postgres:16-trixie').start(),
    new RedisContainer('redis:7-alpine').start(),
    new GenericContainer('cgr.dev/chainguard/minio:latest')
      .withCommand(['server', '/data'])
      .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
      .start(),
  ]);

  const databaseUrl = `${pg.getConnectionUri()}?schema=public`;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
    shell: true,
  });

  const s3Endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
  });
  await s3.send(new CreateBucketCommand({ Bucket: 'avatars' }));
  s3.destroy();

  project.provide('DATABASE_URL', databaseUrl);
  project.provide('REDIS_URL', redis.getConnectionUrl());
  project.provide('S3_ENDPOINT', s3Endpoint);
}

export async function teardown() {
  await Promise.all([pg?.stop(), redis?.stop(), minio?.stop()]);
}
