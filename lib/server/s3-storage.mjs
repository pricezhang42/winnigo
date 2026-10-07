import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { database, writeTransaction } from './postgres.mjs';
/** Media IDs are the SHA-256 of the photo bytes, so identical photos share one object. */
export const contentHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const RUNNING_MIGRATION_SQL = "SELECT 1 FROM migration_runs WHERE status='running' LIMIT 1";
// Unreferenced, finished uploads older than the 24-hour grace period.
const EXPIRED_UNREFERENCED_SQL =
  "SELECT id FROM media WHERE status='ready' AND lease_until<now() AND created_at<now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM listing_media WHERE media_id=media.id) ORDER BY id LIMIT 100";

/**
 * Private photo storage: bytes live in an S3-compatible bucket and each object has a `media`
 * row in PostgreSQL (status, size, content type, lease). Reads verify the content hash.
 */
export class S3Storage {
  constructor({
    pool = database(),
    client,
    bucket = process.env.S3_BUCKET,
    prefix = process.env.S3_PREFIX || 'photos/',
  } = {}) {
    if (!bucket || !/^[-a-zA-Z0-9/]+\/$/.test(prefix) || prefix.includes('..'))
      throw Error('Invalid S3 bucket or prefix');
    this.pool = pool;
    this.bucket = bucket;
    this.prefix = prefix;
    this.client =
      client ||
      new S3Client({
        region: process.env.S3_REGION,
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_KEY,
        },
      });
  }
  /** Object key for a media ID; rejects anything that isn't a SHA-256 hex string. */
  key(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error('Invalid media ID');
    return this.prefix + id;
  }
  /** Photo bytes and type, or null if the upload is missing or unfinished. */
  async get(id) {
    const key = this.key(id);
    const row = (await this.pool.query("SELECT * FROM media WHERE id=$1 AND status='ready'", [id]))
      .rows[0];
    if (!row) return null;
    if (row.object_key !== key) throw Error('Media storage namespace mismatch');
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await object.Body.transformToByteArray();
    if (contentHash(bytes) !== id || bytes.length !== Number(row.size))
      throw Error('Media integrity check failed');
    return { bytes, contentType: row.content_type };
  }
  /**
   * Stores a photo in two steps: reserve a `media` row as 'uploading', then write the object
   * (unless an identical one already exists) and mark it 'ready'. Safe to retry.
   */
  async put(id, bytes, contentType) {
    const key = this.key(id);
    if (bytes.length > MAX_PHOTO_BYTES || contentHash(bytes) !== id)
      throw Error('Photo content hash or size mismatch');
    // Reserve before writing S3. Crashes leave an uploading record protected from GC.
    await writeTransaction(this.pool, async (client) => {
      const old = (await client.query('SELECT * FROM media WHERE id=$1', [id])).rows[0];
      if (
        old &&
        (old.object_key !== key ||
          Number(old.size) !== bytes.length ||
          old.content_type !== contentType)
      )
        throw Error('Media identity collision');
      await client.query(
        "INSERT INTO media(id,object_key,content_type,size,status) VALUES($1,$2,$3,$4,'uploading') ON CONFLICT(id) DO UPDATE SET lease_until=now()+interval '24 hours'",
        [id, key, contentType, bytes.length],
      );
    });
    await writeTransaction(this.pool, async (client) => {
      // Reuse an object left by an interrupted earlier attempt if its content matches.
      let object;
      try {
        object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      } catch (e) {
        if (!['NoSuchKey', 'NotFound'].includes(e.name) && e.$metadata?.httpStatusCode !== 404)
          throw e;
      }
      if (object) {
        const existing = await object.Body.transformToByteArray();
        if (contentHash(existing) !== id) throw Error('Existing S3 object hash mismatch');
      } else
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            Metadata: { sha256: id },
            IfNoneMatch: '*',
          }),
        );
      await client.query(
        "UPDATE media SET status='ready',lease_until=now()+interval '24 hours' WHERE id=$1",
        [id],
      );
    });
  }
  /**
   * Deletes an unreferenced photo after its grace period. Refuses while a migration is running,
   * because an unfinished import may be about to reference it.
   */
  async delete(id) {
    return writeTransaction(this.pool, async (client) => {
      if ((await client.query('SELECT 1 FROM listing_media WHERE media_id=$1', [id])).rowCount)
        throw Error('Referenced media cannot be deleted');
      if ((await client.query(RUNNING_MIGRATION_SQL)).rowCount)
        throw Error('Migration in progress');
      const row = (
        await client.query(
          "SELECT * FROM media WHERE id=$1 AND status='ready' AND lease_until<now() AND created_at<now()-interval '24 hours'",
          [id],
        )
      ).rows[0];
      if (!row) throw Error('Media upload is unfinished or grace period has not elapsed');
      if (row.object_key !== this.key(id)) throw Error('Media storage namespace mismatch');
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: row.object_key }));
      await client.query('DELETE FROM media WHERE id=$1', [id]);
    });
  }
  /** Lists (and with `apply`, deletes) up to 100 orphaned photos past their grace period. */
  async cleanup({ apply = false } = {}) {
    if ((await this.pool.query(RUNNING_MIGRATION_SQL)).rowCount)
      return { blocked: 'Migration in progress', candidates: [], deleted: 0 };
    const rows = (await this.pool.query(EXPIRED_UNREFERENCED_SQL)).rows;
    let deleted = 0;
    if (apply)
      for (const { id } of rows) {
        await this.delete(id);
        deleted++;
      }
    return { candidates: rows.map((r) => r.id), deleted };
  }
}
