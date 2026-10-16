import { normalizeEvents, projectEvent, availabilityOn } from '../event-schedule.mjs';
import { localDay } from '../connectors.mjs';
import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
// P1 adapter: one host, atomic snapshots and a cross-process writer lock.
// PostgreSQL replaces this implementation behind the same service boundary.
// The whole collection is one JSON file; there is no access model, so it is owner-only.
export class FixtureRepository {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'collection.json');
  }
  async read() {
    const state = JSON.parse(await readFile(this.file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.listings) || !Array.isArray(state.sources))
      throw Error('Unsupported fixture repository');
    if (state.occurrences)
      for (const record of state.listings)
        record.payload.occurrences = state.occurrences
          .filter((o) => o.listingId === record.id)
          .map(({ listingId, ...o }) => o);
    return state;
  }
  async detail(id, { admin = false, principal } = {}) {
    if (principal?.role !== 'owner') return null;
    const state = await this.read();
    for (const record of state.listings) {
      const event = {
        ...record.payload,
        ...record.override,
        status: record.hidden ? 'hidden' : record.payload.status,
      };
      const match =
        projectEvent(event, { admin }).find((item) => item.id === id) ||
        (event.id === id ? event : null);
      if (
        match &&
        (admin ||
          (!['hidden', 'cancelled'].includes(match.status) &&
            (!match.end || match.end >= localDay())))
      )
        return match;
    }
    return null;
  }
  async availability(id, date, options = {}) {
    const event = await this.detail(id, { ...options, admin: true });
    if (!event || event.status === 'hidden') return null;
    return availabilityOn(event, date);
  }
  async occurrenceTarget(id, principal) {
    if (principal?.role !== 'owner') return null;
    const state = await this.read();
    for (const record of state.listings)
      if (record.id !== id && record.payload.occurrences?.some((o) => o.id === id))
        return { listing_id: record.id, occurrence_id: id };
    return null;
  }
  async updateOccurrence(target, patch, hidden, principal) {
    if (principal?.role !== 'owner') throw Error('Owner required');
    return this.transaction((state) => {
      const occurrence = state.listings
        .find((r) => r.id === target.listing_id)
        ?.payload.occurrences?.find((o) => o.id === target.occurrence_id);
      if (!occurrence) throw Error('Occurrence not found');
      occurrence.override = { ...occurrence.override, ...patch };
      if (hidden !== undefined) occurrence.hidden = hidden;
      return null;
    });
  }
  async health() {
    await access(this.file);
    return true;
  }
  /**
   * Runs `change(state)` on the whole collection and saves it atomically (temp file + rename).
   * A lock directory serialises writers across processes; waits up to ~5 s before giving up.
   */
  async transaction(change) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'write.lock');
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await mkdir(lock);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await delay(25);
      }
    }
    if (!acquired) throw Error('Fixture repository is busy; check for an interrupted writer.');
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      let state;
      try {
        state = await this.read();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { version: 1, listings: [], sources: [] };
      }
      const result = await change(state);
      const originals = new Map(state.listings.map((record) => [record.id, record]));
      const events = normalizeEvents(state.listings.map((record) => record.payload));
      const occurrences = [];
      state.aliases = state.aliases || {};
      state.listings = events.map((event) => {
        const original = originals.get(event.id);
        if (original) delete original.override.occurrenceMode;
        if (original && original.override.visitingSchedule !== undefined) {
          const effective = normalizeEvents([{ ...event, ...original.override }])[0];
          event.occurrences = effective.occurrences;
          event.scheduleCoverage = effective.scheduleCoverage;
        }
        for (const occurrence of event.occurrences) {
          const old = originals.get(occurrence.id);
          const previous = original?.payload.occurrences?.find((o) => o.id === occurrence.id);
          const editorial =
            old && old.id !== event.id
              ? { hidden: old.hidden, override: old.override }
              : { hidden: previous?.hidden || false, override: previous?.override || {} };
          occurrences.push({ ...occurrence, ...editorial, listingId: event.id });
          if (old && old.id !== event.id)
            state.aliases[old.id] = {
              eventId: event.id,
              occurrenceId: occurrence.id,
              archivedRecord: old,
            };
        }
        const { occurrences: children, ...payload } = event;
        return {
          id: event.id,
          source: event.source,
          payload,
          hidden: original?.hidden || false,
          override: original?.override || {},
        };
      });
      state.occurrences = occurrences;
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.file);
      return result;
    } finally {
      await rm(temp, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
