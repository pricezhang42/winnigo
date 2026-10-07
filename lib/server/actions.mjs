import { createHash, randomUUID } from 'node:crypto';
import { canonical } from './postgres-repository.mjs';
import { normalizeSocial, normalizeHikingBatch } from '../social.mjs';
export class ActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export async function applyAction(input, repo, principal) {
  const mutate = (change) =>
    repo.transaction(change, {
      action: input.action,
      id: input.id,
      principal,
      urls: input.items?.map((i) => i.url) || (input.url ? [input.url] : undefined),
    });
  if (input.action === 'refresh')
    throw new ActionError(
      'Live refresh is unavailable in the current runtime. Collection jobs will be enabled in P5.',
      409,
    );
  if (input.action === 'sync-hiking-manitoba') {
    let batch;
    try {
      batch = normalizeHikingBatch(input);
    } catch (e) {
      throw new ActionError(e.message);
    }
    return mutate((state) => {
      let added = 0,
        updated = 0;
      for (const item of batch.items) {
        const existing = state.listings.find(
          (r) => r.source === 'facebook' && canonical(r.payload.url) === canonical(item.url),
        );
        const previous = existing?.payload;
        const id =
          existing?.id || 'facebook-' + createHash('sha256').update(item.url).digest('hex');
        item.addedAt = previous?.addedAt || item.addedAt;
        item.images = [...new Set([...(item.images ?? []), ...(previous?.images ?? [])])].slice(
          0,
          20,
        );
        item.commentNotes = item.commentNotes ?? previous?.commentNotes ?? [];
        item.image = item.images[0] || previous?.image || '';
        if (!existing) {
          added++;
          state.listings.push({
            id,
            source: 'facebook',
            payload: { ...item, id },
            hidden: false,
            override: {},
          });
        } else {
          if (
            [
              'title',
              'description',
              'type',
              'category',
              'start',
              'end',
              'time',
              'venue',
              'neighbourhood',
              'distanceKm',
              'difficulty',
              'status',
              'images',
              'commentNotes',
            ].some((k) => JSON.stringify(previous[k]) !== JSON.stringify(item[k]))
          )
            updated++;
          existing.payload = { ...item, id };
        }
      }
      let report = state.sources.find((s) => s.id === 'facebook');
      if (!report) {
        report = { id: 'facebook', checkedAt: '' };
        state.sources.push(report);
      }
      Object.assign(report, {
        checkedAt: batch.status === 'ok' ? batch.checkedAt : report.checkedAt,
        attemptedAt: batch.checkedAt,
        count: batch.items.length,
        status: batch.status,
        error: batch.message || null,
      });
      return { ok: true, processed: batch.items.length, added, updated, status: batch.status };
    });
  }
  if (input.action === 'add-social') {
    let item;
    try {
      item = normalizeSocial(input);
    } catch (e) {
      throw new ActionError(e.message);
    }
    await mutate((state) => {
      if (
        state.listings.some(
          (r) => canonical(r.payload.url) === canonical(item.url) && r.source === item.source,
        )
      )
        throw new ActionError('This post is already in the collection.', 409);
      const id = 'social-' + randomUUID();
      state.listings.push({
        id,
        source: item.source,
        payload: { ...item, id },
        hidden: false,
        override: {},
      });
    });
    return null;
  }
  if (input.action === 'update' && typeof input.id === 'string') {
    const patch = {};
    if (typeof input.title === 'string' && input.title.trim())
      patch.title = input.title.trim().slice(0, 200);
    if (typeof input.description === 'string') patch.description = input.description.slice(0, 1200);
    if (
      input.price === null ||
      (typeof input.price === 'number' && Number.isFinite(input.price) && input.price >= 0)
    )
      patch.price = input.price;
    if (input.hidden !== undefined && typeof input.hidden !== 'boolean')
      throw new ActionError('Invalid visibility');
    await mutate((state) => {
      const existing = state.listings.find((r) => r.id === input.id);
      if (!existing) throw new ActionError('Listing not found', 404);
      Object.assign(existing.override, patch);
      if (input.hidden !== undefined) existing.hidden = input.hidden;
    });
    return null;
  }
  throw new ActionError('Invalid action');
}
