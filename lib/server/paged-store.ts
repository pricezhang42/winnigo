import 'server-only';
import { repository } from './services';
import { collectableSources } from './collection.mjs';
import official from '../data/official-trails.json';
import { communitySources } from '../social.mjs';
import { schedulesEnabled } from './job-queue.mjs';

type Principal = { userId: string; role: string };
type Filters = Record<string, unknown>;

/**
 * One page of discovery results for the current principal. Filtering, access control and paging
 * happen in SQL; this function merges source metadata into the reports.
 */
export async function searchCollection(filters: Filters, admin = false, principal?: Principal) {
  const page = await repository().search({ ...filters, admin, principal });
  const reportFor = (id: string) => page.reports.find((report) => report.id === id);
  return {
    ...page,
    // Venue and official-trail sources, with their static descriptions merged in.
    sources: page.reports
      .filter((report) => report.id !== 'facebook')
      .map((report) => ({
        ...collectableSources.find((source) => source.id === report.id),
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
