import { createHash, randomUUID } from 'node:crypto';
import { canonical } from './postgres-repository.mjs';
import { normalizeSocial, normalizeHikingBatch } from '../social.mjs';

/** An error whose message is safe to show the caller, with the HTTP status to return. */
export class ActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// A re-imported post counts as "updated" only when one of these fields changed.
const TRACKED_POST_FIELDS = [
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
];
const MAX_POST_IMAGES = 20;

/**
 * Applies one admin or collector action to the collection.
 *
 * Actions: `sync-hiking-manitoba` (collector batch import), `add-social` (add one post by link)
 * and `update` (owner/admin edit). `refresh` is rejected until collection jobs exist (P5).
 * Each mutation runs in a single repository transaction scoped to the affected listings.
 */
export async function applyAction(input, repo, principal) {
  const mutate = (change) =>
    repo.transaction(change, {
      action: input.action,
      id: input.id,
      principal,
      urls: input.items?.map((item) => item.url) || (input.url ? [input.url] : undefined),
    });

  if (input.action === 'refresh')
    throw new ActionError(
      'Live refresh is unavailable in the current runtime. Collection jobs will be enabled in P5.',
      409,
    );
  if (input.action === 'sync-hiking-manitoba') return syncHikingBatch(input, mutate);
  if (input.action === 'add-social') return addSocialPost(input, mutate);
  if (input.action === 'update' && typeof input.id === 'string')
    return updateListing(input, mutate);
  throw new ActionError('Invalid action');
}

/** Converts validation failures from the normalisers into 400 responses. */
function normalized(normalize, input) {
  try {
    return normalize(input);
  } catch (error) {
    throw new ActionError(error.message);
  }
}

/** Merges a collector batch of Hiking Manitoba posts and records the source's check status. */
async function syncHikingBatch(input, mutate) {
  const batch = normalized(normalizeHikingBatch, input);
  return mutate((state) => {
    let added = 0;
    let updated = 0;
    for (const item of batch.items) {
      const existing = state.listings.find(
        (record) =>
          record.source === 'facebook' && canonical(record.payload.url) === canonical(item.url),
      );
      const previous = existing?.payload;
      const id = existing?.id || 'facebook-' + createHash('sha256').update(item.url).digest('hex');

      // Keep earlier photos, notes and the first-seen date when a later check omits them.
      item.addedAt = previous?.addedAt || item.addedAt;
      item.images = [...new Set([...(item.images ?? []), ...(previous?.images ?? [])])].slice(
        0,
        MAX_POST_IMAGES,
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
        continue;
      }
      const changed = TRACKED_POST_FIELDS.some(
        (field) => JSON.stringify(previous[field]) !== JSON.stringify(item[field]),
      );
      if (changed) updated++;
      existing.payload = { ...item, id };
    }

    let report = state.sources.find((source) => source.id === 'facebook');
    if (!report) {
      report = { id: 'facebook', checkedAt: '' };
      state.sources.push(report);
    }
    // `checkedAt` is the last successful check; `attemptedAt` records every attempt.
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

/** Adds a single Facebook or Instagram post entered by the owner. */
async function addSocialPost(input, mutate) {
  const item = normalized(normalizeSocial, input);
  await mutate((state) => {
    const duplicate = state.listings.some(
      (record) =>
        canonical(record.payload.url) === canonical(item.url) && record.source === item.source,
    );
    if (duplicate) throw new ActionError('This post is already in the collection.', 409);
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

/**
 * Saves editorial overrides (title, description, price) and the hidden flag. Overrides are
 * stored separately from the source payload so later imports never erase them.
 */
async function updateListing(input, mutate) {
  const patch = {};
  if (typeof input.title === 'string' && input.title.trim())
    patch.title = input.title.trim().slice(0, 200);
  if (typeof input.description === 'string') patch.description = input.description.slice(0, 1200);
  const validPrice =
    input.price === null ||
    (typeof input.price === 'number' && Number.isFinite(input.price) && input.price >= 0);
  if (validPrice) patch.price = input.price;
  if (input.hidden !== undefined && typeof input.hidden !== 'boolean')
    throw new ActionError('Invalid visibility');

  await mutate((state) => {
    const existing = state.listings.find((record) => record.id === input.id);
    if (!existing) throw new ActionError('Listing not found', 404);
    Object.assign(existing.override, patch);
    if (input.hidden !== undefined) existing.hidden = input.hidden;
  });
  return null;
}
