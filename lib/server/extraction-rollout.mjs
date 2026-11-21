// Per-source extraction over pages already fetched by collectors. Shadow records comparisons;
// opt-in write mode returns accepted candidates with per-page parser fallback.
import { cacheEventExtraction } from './cached-event-extraction.mjs';
import { prepareExtractedCollection } from './event-extraction-integration.mjs';
import { prepareExtractionContext } from './event-page-preparation.mjs';
import { occurrenceSlot } from './extracted-event-schedule.mjs';
import { createConfiguredEventExtractionService } from './openai-event-extraction.mjs';
import { TOURISM_ID } from './tourism-winnipeg.mjs';
import { MUSEUM_ID } from './museum.mjs';
import { WAG_SOURCE_ID } from './wag.mjs';
import { HTML_EVENT_SOURCES } from './html-events.mjs';
import { MUSIC_ID } from './manitoba-music.mjs';
import { ROTARY_SOURCE_ID } from './rotary.mjs';

/** Collectors that report their fetched event pages through `onEventPage`. */
export const EXTRACTION_PAGE_SOURCES = new Set([
  MUSEUM_ID,
  WAG_SOURCE_ID,
  TOURISM_ID,
  ...HTML_EVENT_SOURCES,
  MUSIC_ID,
  ROTARY_SOURCE_ID,
]);
export const ROLLOUT_MODES = new Set(['shadow', 'write']);
const DEFAULT_SHADOW_MS = 180_000;
const MAX_PAGES = 400;
const CONCURRENCY = 2;

/**
 * Parse `WINNIGO_EXTRACTION_SOURCES`, for example `manitoba-museum=shadow`. Empty means
 * extraction is off for every source. Unknown sources or modes fail at startup.
 */
export function readExtractionRollout(env = process.env) {
  const value = (env.WINNIGO_EXTRACTION_SOURCES || '').trim();
  const rollout = new Map();
  if (!value) return rollout;
  for (const entry of value.split(',')) {
    const [sourceId, mode, extra] = entry.trim().split('=');
    if (extra !== undefined || !sourceId || !mode)
      throw Error(
        'WINNIGO_EXTRACTION_SOURCES entries must look like source=shadow or source=write',
      );
    if (!EXTRACTION_PAGE_SOURCES.has(sourceId))
      throw Error(`Extraction is not available for source ${sourceId}`);
    if (!ROLLOUT_MODES.has(mode))
      throw Error(`Unsupported extraction mode ${mode}; use shadow or write`);
    if (rollout.has(sourceId)) throw Error(`Extraction source ${sourceId} is listed twice`);
    rollout.set(sourceId, mode);
  }
  if ((env.WINNIGO_EXTRACTION_PROVIDER || 'disabled') === 'disabled')
    throw Error('WINNIGO_EXTRACTION_SOURCES requires WINNIGO_EXTRACTION_PROVIDER');
  return rollout;
}

/**
 * Build the per-run extraction hook used by `runCollection`. `createService` returns a fresh
 * provider service, so each run has its own spending cap.
 */
export function configureExtractionRollout(
  env = process.env,
  { createService = () => createConfiguredEventExtractionService(env) } = {},
) {
  const rollout = readExtractionRollout(env);
  const maxMs = Number(env.WINNIGO_EXTRACTION_SHADOW_MAX_MS || DEFAULT_SHADOW_MS);
  if (!Number.isInteger(maxMs) || maxMs < 1000)
    throw Error('WINNIGO_EXTRACTION_SHADOW_MAX_MS must be a whole number of milliseconds');
  const maxPages = Number(env.WINNIGO_EXTRACTION_MAX_PAGES || 100);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES)
    throw Error('WINNIGO_EXTRACTION_MAX_PAGES must be an integer from 1 to 400');
  return {
    modeFor: (sourceId) => rollout.get(sourceId) ?? null,
    forSource(source, { pool, checkedAt }) {
      const mode = rollout.get(source.id);
      if (!mode) return null;
      return createExtractionShadow({
        mode,
        pool,
        source,
        checkedAt,
        maxMs,
        maxPages,
        extractor: cacheEventExtraction(pool, createService()),
      });
    },
  };
}

let configured;
/** Reads the environment once per process; the worker validates it at startup. */
export const defaultExtractionRollout = {
  forSource: (source, options) =>
    (configured ??= configureExtractionRollout()).forSource(source, options),
};

const text = (value) =>
  typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
const same = (a, b) => text(a).toLocaleLowerCase('en-CA') === text(b).toLocaleLowerCase('en-CA');
const slots = (item) =>
  Array.isArray(item.occurrences) && item.occurrences.length
    ? item.occurrences.map(occurrenceSlot)
    : [item.startAt || item.start].filter(Boolean);
const runDates = (item) => {
  const { start = null, end = null, endMonth = null } = item.runDates || {};
  return { start, end, endMonth };
};

// Local sessions: Winnipeg calendar day plus timestamp when known.
const sessions = (item) =>
  (Array.isArray(item.occurrences) && item.occurrences.length
    ? item.occurrences
    : [{ start: item.start, startAt: item.startAt }]
  )
    .filter((row) => row.start)
    .map((row) => ({ day: row.start, at: row.startAt || null }));

/**
 * Sessions the candidate has that the reference lacks. A day the reference keeps without a
 * time matches any time the candidate read for that day.
 */
function extraSessions(candidate, referenceItems) {
  const byDay = new Map();
  for (const s of referenceItems.flatMap(sessions)) {
    const times = byDay.get(s.day) || new Set();
    times.add(s.at);
    byDay.set(s.day, times);
  }
  const ours = sessions(candidate);
  const extra = ours.filter((s) => {
    const times = byDay.get(s.day);
    return !times || (s.at && !times.has(null) && !times.has(s.at));
  });
  return {
    extra: extra.map((s) => s.at || s.day).sort(),
    shared: ours.length - extra.length,
    referenceCount: byDay.size,
  };
}

/**
 * Field differences between the extraction candidate and the parser listings for one page.
 * With `{ reference: true }` (review mode against another source's listings), sessions are
 * matched by local day when either side lacks a time, and run dates and price count only when
 * the reference has them: a missing value there is new information, not a disagreement.
 */
export function compareExtraction(candidate, parserItems, { reference = false } = {}) {
  const differences = [];
  const first = parserItems[0];
  if (!first) return [{ field: 'listing', parser: null, extraction: candidate.title }];
  if (!same(candidate.title, first.title))
    differences.push({ field: 'title', parser: first.title, extraction: candidate.title });
  if (!same(candidate.venue, first.venue))
    differences.push({ field: 'venue', parser: first.venue, extraction: candidate.venue });
  // A collector may add sessions from calendar pages that the detail page does not list, so
  // fewer extracted sessions is coverage, not disagreement. Sessions the parser lacks, or no
  // shared session at all, are differences.
  const parsed = new Set(parserItems.flatMap(slots));
  const extracted = new Set(slots(candidate));
  const { extra, shared, referenceCount } = reference
    ? extraSessions(candidate, parserItems)
    : {
        extra: [...extracted].filter((slot) => !parsed.has(slot)).sort(),
        shared: [...extracted].filter((slot) => parsed.has(slot)).length,
        referenceCount: parsed.size,
      };
  if (extra.length || (referenceCount && !shared))
    differences.push({
      field: 'occurrences',
      parser: [...parsed].sort().slice(0, 20),
      extraction: (extra.length ? extra : [...extracted].sort()).slice(0, 20),
    });
  const referenceRun = Object.values(runDates(first)).some(Boolean);
  if (
    (!reference || referenceRun) &&
    JSON.stringify(runDates(candidate)) !== JSON.stringify(runDates(first))
  )
    differences.push({
      field: 'runDates',
      parser: runDates(first),
      extraction: runDates(candidate),
    });
  if (
    (!reference || typeof first.price === 'number') &&
    (candidate.price ?? null) !== (first.price ?? null) &&
    typeof candidate.price === 'number'
  )
    differences.push({ field: 'price', parser: first.price ?? null, extraction: candidate.price });
  return differences;
}

const summary = (candidate) => ({
  title: candidate.title,
  venue: candidate.venue,
  price: candidate.price ?? null,
  runDates: candidate.runDates ?? null,
  occurrences: slots(candidate).slice(0, 50),
});

/**
 * Collects pages during a run and compares them afterwards. A page is
 * `{url, html, selector?, exclude?, id, itemIds}`, where `id` is the parent listing the parser
 * produced from it and `itemIds` every listing it produced.
 */
export function createExtractionShadow({
  pool,
  source,
  checkedAt,
  extractor,
  maxMs,
  mode = 'shadow',
  maxPages = 100,
  // Review mode (configurable AI sources): reference listings to compare candidates with.
  reference = null,
}) {
  const pages = [];
  return {
    mode,
    capture(page) {
      if (
        pages.length < MAX_PAGES &&
        page?.url &&
        page.html &&
        !pages.some((p) => p.url === page.url)
      )
        pages.push(page);
    },
    async finish({ runId, items, knownListings = new Map() }) {
      const signal = AbortSignal.timeout(maxMs);
      const byId = new Map(items.map((item) => [item.id, item]));
      const rows = [];
      const replacements = new Map();
      let stopped = null;
      let attempted = 0;
      const compareOne = async (page) => {
        const row = { page_url: page.url, cache_hit: false, differences: [], extracted: null };
        if (attempted++ >= maxPages) return { ...row, outcome: 'skipped', reason: 'page-limit' };
        if (stopped || signal.aborted)
          return { ...row, outcome: 'skipped', reason: stopped || 'time-limit' };
        let context;
        try {
          context = prepareExtractionContext({
            source: source.id,
            pageUrl: page.url,
            checkedAt,
            pages: [
              { url: page.url, html: page.html, selector: page.selector, exclude: page.exclude },
              ...(page.supportingPages || []),
            ],
          });
        } catch {
          return { ...row, outcome: 'failed', reason: 'preparation-failed' };
        }
        let extraction;
        try {
          extraction = await extractor.extract(context, { signal });
        } catch (error) {
          const code = error?.code || 'extraction-failed';
          if (code === 'budget_exceeded') stopped = 'budget';
          if (code === 'aborted' || code === 'timeout') {
            if (signal.aborted) return { ...row, outcome: 'skipped', reason: 'time-limit' };
          }
          return { ...row, outcome: 'failed', reason: code };
        }
        row.cache_hit = Boolean(extraction.cacheHit);
        row.estimated_cost_usd = extraction.cacheHit ? 0 : (extraction.estimatedCostUsd ?? null);
        if (page.reviewOnly)
          return { ...row, outcome: 'withheld', reason: page.reviewOnly, raw: extraction.result };
        // Review mode has no parser: map the extraction alone and keep it for a person.
        if (mode === 'review') {
          const mapped = await prepareExtractedCollection(extraction.result, context, {
            source,
            identifyEvent: (url) => ({ eventUrl: url, id: page.id }),
          });
          const [candidate] = mapped.items;
          const held = mapped.review[0]?.reason || mapped.failedPages[0]?.error || 'no-candidate';
          // A crawler cannot know dates before reading a page; events outside the
          // collection window need no review.
          if (!candidate && held === 'no-dates-in-collection-window')
            return { ...row, outcome: 'skipped', reason: 'outside-collection-window' };
          if (!candidate)
            return { ...row, outcome: 'withheld', reason: held, raw: extraction.result };
          const ref = reference?.get(page.url);
          if (!ref)
            return {
              ...row,
              outcome: 'candidate',
              reason: null,
              extracted: summary(candidate),
              raw: extraction.result,
            };
          const differences = compareExtraction(candidate, [ref], { reference: true });
          return {
            ...row,
            outcome: differences.length ? 'differ' : 'agree',
            reason: differences.map((d) => d.field).join(',') || null,
            differences,
            extracted: {
              ...summary(candidate),
              parserOccurrences: slots(ref).length,
              reference: ref.id,
            },
            raw: extraction.result,
          };
        }
        const parserItems = (page.itemIds || [page.id]).map((id) => byId.get(id)).filter(Boolean);
        if (
          page.calendarSchedule === 'dates' &&
          (parserItems.length !== 1 || !parserItems[0].occurrences?.length)
        )
          return {
            ...row,
            outcome: 'withheld',
            reason: 'calendar-schedule-unavailable',
            raw: extraction.result,
          };
        const mappingKnown = new Map(knownListings);
        // Calendar-backed adapters supply stable canonical identity and published sessions.
        if (
          page.annualEdition ||
          page.refineDateOnly ||
          page.calendarSchedule === 'dates' ||
          (mode === 'write' && page.calendarSchedule)
        )
          for (const item of parserItems)
            if (!mappingKnown.has(item.id)) mappingKnown.set(item.id, item);
        // Date-authoritative sources preview the same enrichment in shadow and write modes.
        const mapped = await prepareExtractedCollection(extraction.result, context, {
          source,
          allowUndated: Boolean(page.annualEdition || page.dateReview),
          refineDateOnly: Boolean(page.refineDateOnly),
          ...(mode === 'write' ||
          page.annualEdition ||
          page.refineDateOnly ||
          page.calendarSchedule === 'dates'
            ? { knownListings: mappingKnown }
            : {}),
          ...(page.calendarSchedule === 'dates' ? { calendarListing: parserItems[0] } : {}),
          identifyEvent: (url) => ({
            eventUrl: page.eventUrl || url,
            id: page.id,
            ...(page.sourceIdentity ? { sourceIdentity: page.sourceIdentity } : {}),
          }),
        });
        const [candidate] = mapped.items;
        if (!candidate)
          return {
            ...row,
            outcome: 'withheld',
            reason: mapped.review[0]?.reason || mapped.failedPages[0]?.error || 'no-candidate',
            raw: extraction.result,
          };
        if (mode === 'write' && page.calendarSchedule === true) {
          const calendar = parserItems.flatMap((item) => item.occurrences || []);
          const bySlot = new Map(calendar.map((row) => [occurrenceSlot(row), row]));
          const conflict = candidate.occurrences.some((row) => {
            const published = bySlot.get(occurrenceSlot(row));
            return (
              !published ||
              row.status !== published.status ||
              row.end !== published.end ||
              (row.endTimeKnown !== false &&
                published.endTimeKnown !== false &&
                row.endAt &&
                published.endAt &&
                row.endAt !== published.endAt)
            );
          });
          if (!calendar.length || conflict)
            return {
              ...row,
              outcome: 'withheld',
              reason: 'calendar-schedule-conflict',
              raw: extraction.result,
            };
          // A detail page may list one session while the calendars publish many. Preserve
          // the complete collected calendar set, including cancellation states and IDs.
          candidate.occurrences = calendar;
          candidate.runDates = parserItems[0].runDates || candidate.runDates;
          candidate.recurring ||= parserItems.some((item) => item.recurring) || calendar.length > 1;
          if (candidate.recurring) {
            candidate.schedule = 'series';
            candidate.time = '';
            delete candidate.start;
            delete candidate.end;
          }
        }
        if (mode === 'write') {
          const parsed = parserItems[0];
          // Media has already been validated and stored by the collector. Do not import
          // model image URLs or bypass a failed collector photo download.
          if (!parsed && candidate.extraction.photoCandidates.length && !candidate.images?.length)
            return { ...row, outcome: 'withheld', reason: 'collector-photos-unavailable' };
          if (parsed) {
            // WAG subtitles distinguish programs that share a series heading.
            if (candidate.title === parsed.title.split(' — ')[0]) candidate.title = parsed.title;
            for (const key of ['images', 'image', 'sourceImages', 'imageCaption'])
              if (parsed[key] !== undefined) candidate[key] = parsed[key];
            if (parsed.status === 'cancelled') candidate.status = 'cancelled';
            if (
              candidate.availability === 'unknown' &&
              parsed.availability &&
              parsed.availability !== 'unknown'
            ) {
              candidate.availability = parsed.availability;
              candidate.availabilityText = parsed.availabilityText || '';
            }
            for (const key of [
              'availability',
              'availabilityText',
              'admission',
              'family',
              'indoor',
              'ticketUrl',
              'officialUrl',
              'price',
            ]) {
              if (key === 'price' && candidate.extraction.price) continue;
              if (parsed[key] !== undefined) candidate[key] ??= parsed[key];
            }
          }
        }
        const differences = compareExtraction(candidate, parserItems);
        if (mode === 'write')
          replacements.set(page.url, { candidate, ids: page.itemIds || [page.id] });
        return {
          ...row,
          outcome: differences.length ? 'differ' : 'agree',
          reason: differences.map((d) => d.field).join(',') || null,
          differences,
          extracted: {
            ...summary(candidate),
            parserOccurrences: new Set(parserItems.flatMap(slots)).size,
          },
          // Agreeing pages need no diagnosis; keep the model output only where a person looks.
          ...(differences.length ? { raw: extraction.result } : {}),
        };
      };
      const queue = [...pages];
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          while (queue.length) {
            const page = queue.shift();
            rows.push(
              await compareOne(page).catch(() => ({
                page_url: page.url,
                outcome: 'failed',
                reason: 'comparison-failed',
                cache_hit: false,
                differences: [],
                extracted: null,
              })),
            );
          }
        }),
      );
      for (const row of rows)
        await pool.query(
          `INSERT INTO event_extraction_comparisons
             (run_id, source, page_url, outcome, reason, cache_hit, estimated_cost_usd, differences, extracted, raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            runId,
            source.id,
            row.page_url,
            row.outcome,
            row.reason ?? null,
            row.cache_hit,
            row.estimated_cost_usd ?? null,
            JSON.stringify(row.differences),
            row.extracted && JSON.stringify(row.extracted),
            row.raw ? JSON.stringify(row.raw) : null,
          ],
        );
      const count = (outcome) => rows.filter((row) => row.outcome === outcome).length;
      const counts = {
        mode,
        ...(mode === 'write'
          ? {
              imported: replacements.size,
              fallback: pages.filter((p) => !p.reviewOnly).length - replacements.size,
            }
          : {}),
        pages: rows.length,
        ...(pages.some((p) => p.reviewOnly)
          ? { reviewOnly: pages.filter((p) => p.reviewOnly).length }
          : {}),
        ...(mode === 'review' ? { candidate: count('candidate') } : {}),
        agree: count('agree'),
        differ: count('differ'),
        withheld: count('withheld'),
        failed: count('failed'),
        skipped: count('skipped'),
        cacheHits: rows.filter((row) => row.cache_hit).length,
        estimatedCostUsd: Number(
          rows.reduce((total, row) => total + (row.estimated_cost_usd || 0), 0).toFixed(6),
        ),
      };
      const note = rows.length
        ? `Extraction ${mode}: ` +
          (mode === 'review' ? `${counts.candidate} candidate(s), ` : '') +
          `${counts.agree}/${rows.length} page(s) agree` +
          (counts.differ ? `, ${counts.differ} differ` : '') +
          (counts.withheld ? `, ${counts.withheld} withheld` : '') +
          (counts.failed ? `, ${counts.failed} failed` : '') +
          (counts.skipped ? `, ${counts.skipped} skipped` : '')
        : null;
      if (mode !== 'write') return { counts, note };
      const replaced = new Set([...replacements.values()].flatMap(({ ids }) => ids));
      return {
        counts,
        note,
        items: [
          ...items.filter((item) => !replaced.has(item.id)),
          ...[...replacements.values()].map(({ candidate }) => candidate),
        ],
      };
    },
  };
}
