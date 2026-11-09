import { categoryFor, eventListingId } from '../connectors.mjs';
import {
  extractionDateResolver,
  parseEventExtraction,
  parseExtractionContext,
} from '../contracts/event-extraction.mjs';
import { eventPhotoType } from './event-photo-type.mjs';
import { mapExtractedSchedule, occurrenceSlot } from './extracted-event-schedule.mjs';

const nonEventSources = new Set(['facebook', 'hiking-manitoba', 'trails-manitoba']);
const categories = new Set([
  'Arts & culture',
  'Music',
  'Food & drink',
  'Family',
  'Outdoors',
  'Experiences',
]);
const scheduleErrors = new Set([
  'conflicting-occurrence',
  'occurrence-limit',
  'mixed-recurrence-and-visiting-hours',
  'missing-recurrence-anchor',
  'imprecise-run-boundary',
  'unconfirmed-visiting-hours',
  'unconfirmed-visiting-hours-bounds',
  'unconfirmed-exception-hours',
  'conflicting-explicit-date',
  'multiple-exhibition-intervals',
  'ambiguous-existing-occurrence',
  'conflicting-existing-end',
  'conflicting-exceptions',
  'ambiguous-date-only-occurrence',
  'conflicting-existing-run',
  'conflicting-existing-hours',
]);
const normalizedText = (s) => s?.replace(/\s+/g, ' ').trim() || '';
function trustedUrl(value) {
  if (typeof value !== 'string') throw Error('Missing source URL');
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password) throw Error('Invalid source URL');
  return u.href;
}
const listingUrls = (item) => [item.url, item.eventUrl].filter(Boolean);

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
      throw Error('ambiguous-existing-occurrence');
    const prior = matching[0];
    if (!prior) return row;
    if (
      row.endTimeKnown !== false &&
      prior.endTimeKnown !== false &&
      row.endAt &&
      prior.endAt &&
      row.endAt !== prior.endAt
    )
      throw Error('conflicting-existing-end');
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
  const withhold = (url, reason) => {
    output.review.push({ url, reason });
    output.failedPages.push({ url, error: reason });
    output.status = 'partial';
  };
  let extraction;
  try {
    extraction = parseEventExtraction(value, context);
  } catch {
    withhold(context.pageUrl, 'invalid-extraction');
    return output;
  }
  if (!extraction.events.length) withhold(context.pageUrl, 'no-event-candidates');
  const resolveDate = extractionDateResolver(context);
  const groups = new Map();
  const byUrl = new Map();
  for (const old of knownListings.values())
    if (old.source === source.id)
      for (const url of new Set(listingUrls(old))) byUrl.set(url, [...(byUrl.get(url) || []), old]);

  for (const event of extraction.events) {
    let identity, eventUrl;
    try {
      identity = identifyEvent(event.sourceUrl);
      eventUrl = trustedUrl(identity?.eventUrl);
    } catch {
      withhold(event.sourceUrl, 'unapproved-event-url');
      continue;
    }
    const matches = new Map(
      [...(byUrl.get(event.sourceUrl) || []), ...(byUrl.get(eventUrl) || [])].map((old) => [
        old.id,
        old,
      ]),
    );
    const knownId = matches.keys().next().value;
    const id = identity.id || knownId || eventListingId(source.id, eventUrl);
    const old = knownListings.get(id);
    if (
      typeof id !== 'string' ||
      !id ||
      matches.size > 1 ||
      (knownId && knownId !== id) ||
      (old &&
        (old.source !== source.id ||
          old.type !== 'Event' ||
          old.sourceVisibility === 'private' ||
          (identity.sourceIdentity &&
            old.sourceIdentity &&
            identity.sourceIdentity !== old.sourceIdentity) ||
          (!matches.has(id) &&
            (!identity.sourceIdentity || identity.sourceIdentity !== old.sourceIdentity))))
    ) {
      withhold(event.sourceUrl, 'ambiguous-event-identity');
      continue;
    }
    const group = groups.get(id) || [];
    group.push({ event, eventUrl, sourceIdentity: identity.sourceIdentity, old });
    groups.set(id, group);
  }

  const photoCache = new Map();
  if (photos)
    for (const old of knownListings.values()) {
      if (old.source !== source.id || old.sourceVisibility === 'private') continue;
      for (const { image, url } of savedPhotos(old)) if (url) photoCache.set(url, image);
    }
  for (const [id, group] of groups) {
    const { event, eventUrl, sourceIdentity, old } = group[0];
    const facts = (e) => JSON.stringify({ ...e, evidence: [] });
    if (group.some((g) => g.eventUrl !== eventUrl || facts(g.event) !== facts(event))) {
      withhold(event.sourceUrl, 'conflicting-event-candidates');
      continue;
    }
    if (event.reviewReasons.length) {
      withhold(event.sourceUrl, 'source-facts-need-review');
      continue;
    }
    if (old?.status === 'cancelled' && event.status !== 'cancelled') {
      withhold(event.sourceUrl, 'existing-cancelled-event');
      continue;
    }
    const title = normalizedText(event.title),
      venue =
        normalizedText(event.venue?.name) ||
        (event.venue?.mode === 'online' ? 'Online' : old?.venue);
    if (!title || !venue) {
      withhold(event.sourceUrl, 'missing-title-or-venue');
      continue;
    }
    const amount = event.price?.amount;
    if (amount > 0 && event.price.currency && event.price.currency !== 'CAD') {
      withhold(event.sourceUrl, 'unsupported-admission-currency');
      continue;
    }
    const price =
      typeof amount === 'number' && (amount === 0 || event.price.currency === 'CAD')
        ? amount
        : (old?.price ?? null);
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
      category: categories.has(event.category)
        ? event.category
        : old?.category || categoryFor(title),
      description: normalizedText(event.description) || old?.description || '',
      ...(event.organizerUrl ? { officialUrl: event.organizerUrl } : {}),
      ...(event.ticketUrl ? { ticketUrl: event.ticketUrl } : {}),
      status: old?.status === 'hidden' ? 'hidden' : event.status || old?.status || 'active',
      checkedAt: context.checkedAt,
      provenance: 'event-extraction',
      occurrencesComplete: false,
      // No model-derived proof of coverage is stored or used to cancel missing dates.
      scheduleCoverage: [],
      extraction: {
        schemaVersion: extraction.schemaVersion,
        evidence: event.evidence,
        schedule: event.schedule,
        price: event.price,
        venueMode: event.venue?.mode ?? null,
        photoCandidates: event.images,
      },
    };
    try {
      const schedule = mapExtractedSchedule(event, item, context, resolveDate);
      const knownRun = old?.runDates || {};
      const newRun = schedule.runDates;
      if (
        (knownRun.start && newRun.start && knownRun.start !== newRun.start) ||
        (knownRun.end && newRun.end && knownRun.end !== newRun.end) ||
        schedule.occurrences.some(
          (row) =>
            (knownRun.start && row.start < knownRun.start) ||
            (knownRun.end && row.end > knownRun.end) ||
            (knownRun.endMonth && row.end.slice(0, 7) > knownRun.endMonth),
        ) ||
        ((knownRun.end || knownRun.endMonth) &&
          (newRun.end || newRun.endMonth) &&
          (knownRun.end || knownRun.endMonth).slice(0, 7) !==
            (newRun.end || newRun.endMonth).slice(0, 7))
      )
        throw Error('conflicting-existing-run');
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
        throw Error('conflicting-existing-hours');
      item.occurrences = keepOccurrenceIdentities(schedule.occurrences, old);
      if (!item.occurrences.length) {
        withhold(event.sourceUrl, 'no-dates-in-collection-window');
        continue;
      }
      item.runDates = { ...old?.runDates, ...schedule.runDates };
      if (schedule.runDates.end) delete item.runDates.endMonth;
      else if (old?.runDates?.end) delete item.runDates.endMonth;
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
      delete item.start;
      delete item.end;
      delete item.endMonth;
      if (!item.recurring) ({ start: item.start, end: item.end } = item.occurrences[0]);
      delete item.startAt;
      delete item.endAt;
      delete item.seriesId;
      delete item.occurrenceSamples;
    } catch (error) {
      withhold(
        event.sourceUrl,
        scheduleErrors.has(error.message) ? error.message : 'unresolved-schedule',
      );
      continue;
    }

    setPhotos(item, savedPhotos(old));
    if (!item.images.length) delete item.imageCaption;
    if (photos && event.images?.length) {
      const candidates = new Map();
      try {
        for (const image of [...event.images].sort(
          (a, b) => Number(b.kind === 'event') - Number(a.kind === 'event'),
        )) {
          const url = trustedUrl(photos.validateUrl(image.url, 'photo'));
          if (!candidates.has(url)) candidates.set(url, image);
        }
        // A fallback photo should not displace an already stored event cover.
        if (
          !item.images.length ||
          [...candidates.values()].some((image) => image.kind === 'event')
        ) {
          const stored = [];
          for (const url of [...candidates.keys()].slice(0, photoLimit)) {
            let image = photoCache.get(url);
            if (!image) {
              const bytes = await photos.read(url, 'photo');
              const contentType =
                Buffer.isBuffer(bytes) && bytes.length <= 8 * 1024 * 1024 && eventPhotoType(bytes);
              if (!contentType) throw Error('Invalid event photo bytes');
              image = await photos.storePhoto({ bytes, contentType });
              if (!privatePhoto.test(image)) throw Error('Invalid stored event photo');
              photoCache.set(url, image);
            }
            if (!stored.some((entry) => entry.image === image)) stored.push({ image, url });
          }
          setPhotos(item, stored);
          const cover = candidates.get(item.sourceImages[0]);
          if (cover?.kind === 'venue' || cover?.kind === 'artist')
            item.imageCaption = `Source-supplied ${cover.kind} photo.`;
          else if (
            item.sourceImages.some((url) => ['venue', 'artist'].includes(candidates.get(url)?.kind))
          )
            item.imageCaption = 'Includes a source-supplied venue or artist photo.';
          else delete item.imageCaption;
        }
      } catch {
        output.failedPages.push({ url: event.sourceUrl, error: 'photo-enrichment-failed' });
        output.status = 'partial';
      }
    }
    output.items.push(item);
  }
  return output;
}
