import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
/** File-based photo storage for the fixture adapter: one base64 JSON file per photo. */
export class FixtureStorage {
  constructor(directory) {
    this.directory = join(directory, 'photos');
  }
  path(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error('Invalid media ID');
    return join(this.directory, id + '.json');
  }
  async get(id) {
    try {
      const photo = JSON.parse(await readFile(this.path(id), 'utf8'));
      return { bytes: Buffer.from(photo.body, 'base64'), contentType: photo.contentType };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async put(id, bytes, contentType) {
    if (bytes.byteLength > 8 * 1024 * 1024) throw Error('Photo too large');
    const path = this.path(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(
        temp,
        JSON.stringify({ body: Buffer.from(bytes).toString('base64'), contentType }),
        { mode: 0o600, flag: 'wx' },
      );
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async delete(id) {
    await rm(this.path(id), { force: true });
  }
}
