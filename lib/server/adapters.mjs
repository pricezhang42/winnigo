import { readConfig } from './config.mjs';
import { FixtureRepository } from './fixture-repository.mjs';
import { FixtureStorage } from './fixture-storage.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { S3Storage } from './s3-storage.mjs';
let s3;
export function getRepository() {
  const c = readConfig();
  return c.repository === 'postgres' ? new PostgresRepository() : new FixtureRepository(c.dataDir);
}
export function getStorage() {
  const c = readConfig();
  return c.storage === 's3' ? (s3 ??= new S3Storage()) : new FixtureStorage(c.dataDir);
}
