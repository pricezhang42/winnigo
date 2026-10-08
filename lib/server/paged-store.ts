import 'server-only';
import { repository } from './services';
import { getCollection } from '../store';
import { sources, localDay, weekendRange } from '../connectors.mjs';
import official from '../data/official-trails.json';
import { communitySources } from '../social.mjs';
import { schedulesEnabled } from './job-queue.mjs';
import type { Listing } from '../domain';

type Principal = { userId: string; role: string };
type Filters = Record<string, unknown>;

const TAB_TYPES: Record<string, string> = {
  Events: 'Event',
  Places: 'Place',
  Activities: 'Activity',
};
const isOutdoorCategory = (category: string) => ['Hiking', 'Cycling'].includes(category);

/**
 * One page of discovery results for the current principal.
 *
 * With PostgreSQL, filtering, access control and paging happen in SQL and this function only
 * merges source metadata into the reports. The file-based fixture repository has no access
 * model, so it is owner-only and filtered in memory.
 */
export async function searchCollection(filters: Filters, admin = false, principal?: Principal) {
  const repo = repository();
  if (repo.search) {
    const page = await repo.search({ ...filters, admin, principal });
    const reportFor = (id: string) => page.reports.find((report) => report.id === id);
    return {
      ...page,
      // Venue and official-trail sources, with their static descriptions merged in.
      sources: page.reports
        .filter((report) => report.id !== 'facebook')
        .map((report) => ({
          ...sources.find((source) => source.id === report.id),
          ...(report.id === 'trails-manitoba' ? official.source : {}),
          ...report,
          error: admin ? report.error : undefined,
        })),
      // Community sources are listed only when the principal can see some of their items.
      communitySources: communitySources
        .filter((source) => principal?.role === 'owner' || reportFor(source.id))
        .map((source) => ({ ...source, ...reportFor(source.id) })),
      reports: undefined,
      notice: schedulesEnabled()
        ? 'Sources are checked daily. Confirm details with the source before visiting.'
        : 'Automatic source collection is not running. Check source dates before visiting.',
    };
  }

  if (principal?.role !== 'owner') throw Error('Fixture access requires owner');
  const data = await getCollection(admin);
  // Fixture compatibility is intentionally in-memory; PostgreSQL queries stay bounded.
  const matches = fixtureMatcher(filters, admin, localDay());
  const items = data.items.filter(matches);
  const offset = Number(filters.offset || 0);
  const limit = Number(filters.limit || 24);
  return {
    ...data,
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    areas: [...new Set(data.items.map((item) => item.neighbourhood))].sort(),
  };
}

/** In-memory equivalent of the SQL search filters in postgres-repository.mjs. */
function fixtureMatcher(filters: Filters, admin: boolean, today: string) {
  const { query, collection, category, area, tab, quick, season, difficulty, distance } = filters;
  const savedIds = (filters.ids as string[]) || [];
  const weekend = weekendRange(today);
  const runsBetween = (item: Listing, first: string, last: string) =>
    item.schedule === 'event' &&
    !!item.start &&
    item.start <= last &&
    (item.end || item.start) >= first;

  const checks: ((item: Listing) => boolean)[] = [
    (item) =>
      !query ||
      `${item.title} ${item.venue} ${item.category} ${admin ? item.sourceName : ''}`
        .toLowerCase()
        .includes(String(query).toLowerCase()),
    (item) => !collection || collection === 'All discoveries' || item.collection === collection,
    (item) =>
      !category ||
      category === 'All' ||
      item.category === category ||
      !!item.activityCategories?.includes(String(category)) ||
      (category === 'Outdoors' && isOutdoorCategory(item.category)),
    (item) => !area || area === 'All neighbourhoods' || item.neighbourhood === area,
    (item) => !Object.keys(TAB_TYPES).includes(String(tab)) || item.type === TAB_TYPES[String(tab)],
    (item) =>
      tab !== 'Trail map' || item.source === 'trails-manitoba' || isOutdoorCategory(item.category),
    (item) => tab !== 'Saved' || savedIds.includes(item.id),
    (item) => quick !== 'Free' || item.price === 0,
    (item) => quick !== 'Family-friendly' || !!item.family,
    (item) => quick !== 'Indoors' || !!item.indoor,
    (item) => quick !== 'Today' || runsBetween(item, today, today),
    (item) => quick !== 'This weekend' || runsBetween(item, weekend.first, weekend.last),
    (item) => !season || season === 'Any' || !!item.seasons?.includes(String(season)),
    (item) => !difficulty || difficulty === 'Any' || (item.difficulty || 'Unknown') === difficulty,
    (item) => !distance || distance === 'Any' || matchesDistance(item.distanceKm, distance),
  ];
  return (item: Listing) => checks.every((check) => check(item));
}

/** Route length buckets: short ≤ 5 km, medium 5–15 km, anything else > 15 km. */
function matchesDistance(km: number | null | undefined, bucket: unknown) {
  if (km == null) return false;
  if (bucket === 'short') return km <= 5;
  if (bucket === 'medium') return km > 5 && km <= 15;
  return km > 15;
}
