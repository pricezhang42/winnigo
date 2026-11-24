import { PostgresRepository } from './postgres-repository.mjs';
import { S3Storage } from './s3-storage.mjs';

// PostgreSQL pools are shared per process, so a new repository object is cheap; the S3 client is
// created once and reused.
let s3;
export const getRepository = () => new PostgresRepository();
export const getStorage = () => (s3 ??= new S3Storage());
