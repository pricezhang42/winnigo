import { readConfig } from './config.mjs';
import { FixtureRepository } from './fixture-repository.mjs';
import { FixtureStorage } from './fixture-storage.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { S3Storage } from './s3-storage.mjs';

// Selects the configured implementations. PostgreSQL pools are shared per process, so a new
// repository object is cheap; the S3 client is created once and reused.
let s3;
export function getRepository() {
  const config = readConfig();
  return config.repository === 'postgres'
    ? new PostgresRepository()
    : new FixtureRepository(config.dataDir);
}
export function getStorage() {
  const config = readConfig();
  return config.storage === 's3' ? (s3 ??= new S3Storage()) : new FixtureStorage(config.dataDir);
}
