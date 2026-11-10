import { categoryFor, eventListingId, summarize } from '../connectors.mjs';
import {
  extractionDateResolver,
  parseMainEventExtraction,
  parseExtractionContext,
} from '../contracts/event-extraction.mjs';
import { eventPhotoType } from './event-photo-type.mjs';
import {
  mapExtractedSchedule,
  occurrenceSlot,
  ScheduleReviewError,
} from './extracted-event-schedule.mjs';

const nonEventSources = new Set(['facebook', 'hiking-manitoba', 'trails-manitoba']);
const categories = new Set([
  'Arts & culture',
  'Music',
  'Food & drink',
  'Family',
  'Outdoors',
  'Experiences',
]);
const normalizedText = (s) => s?.replace(/\s+/g, ' ').trim() || '';
function trustedUrl(value) {
  if (typeof value !== 'string') throw Error('Missing source URL');
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password) throw Error('Invalid source URL');
  return u.href;
}

function keepOccurrenceIdentities(rows, old) {
  const oldRows = old?.occurrences || [];
  const supplied = new Set(rows.map(occurrenceSlot));
  return rows.map((row) => {
    const matching = oldRows.filter((o) => occurrenceSlot(o) === occurrenceSlot(row));
    if (
      matching.length > 1 ||
      (!matching.length &&
        oldRows.some(
          (o) =>
            o.start === row.start &&
            (!o.startAt ||
              !row.startAt ||
              (o.status === 'active' && !supplied.has(occurrenceSlot(o)))),
        ))
    )
      throw new ScheduleReviewError('ambiguous-existing-occurrence');
    const prior = matching[0];
    if (!prior) return row;
    if (
      row.endTimeKnown !== false &&
      prior.endTimeKnown !== false &&
      row.endAt &&
      prior.endAt &&
      row.endAt !== prior.endAt
    )
      throw new ScheduleReviewError('conflicting-existing-end');
    const status =
      prior.status === 'superseded' || (prior.status === 'cancelled' && row.status === 'active')
        ? prior.status
        : row.status;
    const keepTiming =
      row.endTimeKnown === false &&
      ((prior.endTimeKnown !== false && prior.endAt) || prior.end > row.end);
    return { ...(keepTiming ? prior : row), id: prior.id, url: prior.url, status };
  });
}

const privatePhoto = /^\/api\/photos\/[a-f0-9]{64}$/;
const photoLimit = 3;

function savedPhotos(item) {
  return (item?.images?.length ? item.images : [item?.image])
    .map((image, i) => ({ image, url: item?.sourceImages?.[i] ?? null }))
    .filter(({ image }) => privatePhoto.test(image))
    .slice(0, photoLimit);
}

function setPhotos(item, photos) {
  item.images = photos.map(({ image }) => image);
  item.sourceImages = photos.map(({ url }) => url);
  item.image = item.images[0] || '';
}

function applySchedule(item, event, old, context) {
  const schedule = mapExtractedSchedule(event, item, context, extractionDateResolver(context));
  const knownRun = old?.runDates || {};
  const newRun = schedule.runDates;
  const knownEndMonth = (knownRun.end || knownRun.endMonth)?.slice(0, 7);
  const newEndMonth = (newRun.end || newRun.endMonth)?.slice(0, 7);
  if (
    (knownRun.start && newRun.start && knownRun.start !== newRun.start) ||
    (knownRun.end && newRun.end && knownRun.end !== newRun.end) ||
    schedule.occurrences.some(
      (row) =>
        (knownRun.start && row.start < knownRun.start) ||
        (knownRun.end && row.end > knownRun.end) ||
        (knownRun.endMonth && row.end.slice(0, 7) > knownRun.endMonth),
    ) ||
    (knownEndMonth && newEndMonth && knownEndMonth !== newEndMonth)
  )
    throw new ScheduleReviewError('conflicting-existing-run');
  if (
    old?.visitingSchedule &&
    schedule.occurrences.some(
      (row) =>
        !(old.occurrences || []).some(
          (o) =>
            occurrenceSlot(o) === occurrenceSlot(row) &&
            o.endAt === row.endAt &&
            o.status === row.status,
        ),
    )
  )
    throw new ScheduleReviewError('conflicting-existing-hours');
  item.occurrences = keepOccurrenceIdentities(schedule.occurrences, old);
  if (!item.occurrences.length) throw new ScheduleReviewError('no-dates-in-collection-window');
  item.runDates = { ...old?.runDates, ...schedule.runDates };
  if (item.runDates.end) delete item.runDates.endMonth;
  if (!Object.keys(item.runDates).length) delete item.runDates;
  if (schedule.yearAssumed) item.yearAssumed = true;
  item.recurring = Boolean(
    old?.recurring ||
    event.schedule.kind === 'recurring' ||
    event.schedule.kind === 'exhibition' ||
    item.runDates ||
    item.occurrences.length > 1,
  );
  item.schedule = item.recurring ? 'series' : 'event';
  item.time = item.recurring ? '' : item.occurrences[0].time;
  if (!item.recurring) ({ start: item.start, end: item.end } = item.occurrences[0]);
}

async function applyPhotos(item, event, old, knownListings, photos) {
  setPhotos(item, savedPhotos(old));
  if (!item.images.length) delete item.imageCaption;
  if (!photos || !event.images?.length) return;

  // Image classification is not extracted; keep an existing stored cover.
  if (item.images.length) return;
  const candidates = [
    ...new Set(event.images.map((image) => trustedUrl(photos.validateUrl(image.url, 'photo')))),
  ];

  const cache = new Map();
  for (const listing of knownListings.values()) {
    if (listing.source !== item.source || listing.sourceVisibility === 'private') continue;
    for (const { image, url } of savedPhotos(listing)) if (url) cache.set(url, image);
  }
  const stored = [];
  for (const url of candidates.slice(0, photoLimit)) {
    let image = cache.get(url);
    if (!image) {
      const bytes = await photos.read(url, 'photo');
      const contentType =
        Buffer.isBuffer(bytes) && bytes.length <= 8 * 1024 * 1024 && eventPhotoType(bytes);
      if (!contentType) throw Error('Invalid event photo bytes');
      image = await photos.storePhoto({ bytes, contentType });
      if (!privatePhoto.test(image)) throw Error('Invalid stored event photo');
    }
    if (!stored.some((entry) => entry.image === image)) stored.push({ image, url });
  }
  setPhotos(item, stored);
  delete item.imageCaption;
}

/**
 * Make repository-ready candidates for review. The source adapter supplies trusted
 * identity and optional photo operations. No listing writes happen here.
 */
export async function prepareExtractedCollection(
  value,
  inputContext,
  { source, identifyEvent, knownListings = new Map(), photos } = {},
) {
  const context = parseExtractionContext(inputContext);
  if (
    source?.id !== context.source ||
    !normalizedText(source?.name) ||
    nonEventSources.has(source.id) ||
    typeof identifyEvent !== 'function'
  )
    throw Error('A matching public event source and trusted identity resolver are required');
  if (
    photos &&
    [photos.read, photos.storePhoto, photos.validateUrl].some((fn) => typeof fn !== 'function')
  )
    throw Error('Private photo enrichment requires trusted URL validation, reader and storage');
  const output = {
    sourceId: source.id,
    checkedAt: context.checkedAt,
    items: [],
    review: [],
    failedPages: [],
    completeSchedules: false,
    allowEmpty: false,
    status: 'ok',
  };
  const fail = (url, reason) => {
    output.failedPages.push({ url, error: reason });
    output.status = 'partial';
  };
  const withhold = (url, reason) => {
    output.review.push({ url, reason });
    fail(url, reason);
    return output;
  };
  let event, schemaVersion;
  try {
    const extraction = parseMainEventExtraction(value, context);
    [event] = extraction.events;
    schemaVersion = extraction.schemaVersion;
  } catch {
    return withhold(context.pageUrl, 'invalid-extraction');
  }
  if (!event) return withhold(context.pageUrl, 'no-event-candidates');

  let identity, eventUrl;
  try {
    identity = identifyEvent(event.sourceUrl);
    eventUrl = trustedUrl(identity?.eventUrl);
  } catch {
    return withhold(event.sourceUrl, 'unapproved-event-url');
  }
  const matchingIds = new Set(
    [...knownListings.values()]
      .filter(
        (item) =>
          item.source === source.id &&
          [item.url, item.eventUrl].some((url) => url === event.sourceUrl || url === eventUrl),
      )
      .map((item) => item.id),
  );
  const [knownId] = matchingIds;
  const id = identity.id || knownId || eventListingId(source.id, eventUrl);
  const old = knownListings.get(id);
  const sourceIdentity = identity.sourceIdentity;
  const sameSourceIdentity = sourceIdentity && sourceIdentity === old?.sourceIdentity;
  const needsIdentityMatch =
    old && (!matchingIds.has(id) || (sourceIdentity && old.sourceIdentity));
  const incompatibleListing =
    old && (old.source !== source.id || old.type !== 'Event' || old.sourceVisibility === 'private');
  if (
    typeof id !== 'string' ||
    !id ||
    matchingIds.size > 1 ||
    (knownId && knownId !== id) ||
    incompatibleListing ||
    (needsIdentityMatch && !sameSourceIdentity)
  )
    return withhold(event.sourceUrl, 'ambiguous-event-identity');

  if (event.reviewReasons.length) return withhold(event.sourceUrl, 'source-facts-need-review');
  if (old?.status === 'cancelled' && event.status !== 'cancelled')
    return withhold(event.sourceUrl, 'existing-cancelled-event');
  const title = normalizedText(event.title),
    venue =
      normalizedText(event.venue?.name) || (event.venue?.mode === 'online' ? 'Online' : old?.venue);
  if (!title || !venue) return withhold(event.sourceUrl, 'missing-title-or-venue');
  const amount = event.price?.amount;
  const price = typeof amount === 'number' ? amount : (old?.price ?? null);
  const item = {
    ...old,
    id,
    source: source.id,
    sourceName: source.name,
    url: old?.url || event.sourceUrl,
    eventUrl: old?.eventUrl || eventUrl,
    ...(sourceIdentity || old?.sourceIdentity
      ? { sourceIdentity: old?.sourceIdentity || sourceIdentity }
      : {}),
    title,
    type: 'Event',
    venue,
    address: normalizedText(event.venue?.address) || old?.address || '',
    neighbourhood: old?.neighbourhood || '',
    price,
    ...(event.price?.text ? { admission: normalizedText(event.price.text) } : {}),
    category: categories.has(event.category) ? event.category : old?.category || categoryFor(title),
    // The model does not rewrite descriptions; summarize the prepared page text instead.
    description:
      summarize(context.documents.find((d) => d.url === context.pageUrl)?.text || '') ||
      old?.description ||
      '',
    ...(event.organizerUrl ? { officialUrl: event.organizerUrl } : {}),
    ...(event.ticketUrl ? { ticketUrl: event.ticketUrl } : {}),
    status: old?.status === 'hidden' ? 'hidden' : event.status || old?.status || 'active',
    checkedAt: context.checkedAt,
    provenance: 'event-extraction',
    occurrencesComplete: false,
    // No model-derived proof of coverage is stored or used to cancel missing dates.
    scheduleCoverage: [],
    extraction: {
      schemaVersion,
      evidence: event.evidence,
      schedule: event.schedule,
      price: event.price,
      venueMode: event.venue?.mode ?? null,
      photoCandidates: event.images,
    },
  };
  // Only occurrence rows carry times on a recurring listing.
  for (const key of [
    'start',
    'end',
    'endMonth',
    'startAt',
    'endAt',
    'seriesId',
    'occurrenceSamples',
  ])
    delete item[key];
  try {
    applySchedule(item, event, old, context);
  } catch (error) {
    const reason = error instanceof ScheduleReviewError ? error.message : 'unresolved-schedule';
    return withhold(event.sourceUrl, reason);
  }
  try {
    await applyPhotos(item, event, old, knownListings, photos);
  } catch {
    fail(event.sourceUrl, 'photo-enrichment-failed');
  }
  output.items.push(item);
  return output;
}
