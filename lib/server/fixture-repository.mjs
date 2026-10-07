import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
// P1 adapter: one host, atomic snapshots and a cross-process writer lock.
// PostgreSQL will replace this implementation behind the same service boundary.
export class FixtureRepository {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'collection.json');
  }
  async read() {
    const state = JSON.parse(await readFile(this.file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.listings) || !Array.isArray(state.sources))
      throw Error('Unsupported fixture repository');
    return state;
  }
  async health() {
    await access(this.file);
    return true;
  }
  async transaction(change) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'write.lock');
    let acquired = false;
    for (let n = 0; n < 200; n++) {
      try {
        await mkdir(lock);
        acquired = true;
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        await delay(25);
      }
    }
    if (!acquired) throw Error('Fixture repository is busy; check for an interrupted writer.');
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      let state;
      try {
        state = await this.read();
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        state = { version: 1, listings: [], sources: [] };
      }
      const result = await change(state);
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.file);
      return result;
    } finally {
      await rm(temp, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
