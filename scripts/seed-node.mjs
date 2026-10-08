// Seeds the selected repository with snapshot data, or synthetic QA data when
// WINNIGO_SEED_PROFILE=qa (npm run db:seed). Existing records and owner corrections are kept.
import { readFile } from 'node:fs/promises';
import { loadLocalEnv } from './load-env.mjs';
import { readConfig } from '../lib/server/config.mjs';
import { getRepository, getStorage } from '../lib/server/adapters.mjs';
import { qaImage } from '../lib/server/qa-image.mjs';
import { contentHash } from '../lib/server/s3-storage.mjs';
import { normalizeHikingBatch } from '../lib/social.mjs';
loadLocalEnv();
const config = readConfig();
const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const [listings, sources, official] = await Promise.all([
  json('../lib/data/listings.json'),
  json('../lib/data/sources.json'),
  json('../lib/data/official-trails.json'),
]);
const items = [...listings, ...official.items];
const reports = [...sources, { ...official.source }].map((sourceInfo) => ({
  id: sourceInfo.id,
  checkedAt: sourceInfo.checkedAt,
  attemptedAt: sourceInfo.checkedAt,
  count: sourceInfo.count,
  status: sourceInfo.status,
}));
if (config.profile === 'qa') {
  const fixture = await json('./fixtures/p0-discovery.json');
  const community = {
    ...normalizeHikingBatch({ status: 'ok', items: [fixture.community] }).items[0],
    id: 'p0-community',
  };
  community.image = community.images[0];
  items.push(
    community,
    { ...community, id: 'p0-hidden', title: 'P0 hidden fixture' },
    { ...community, id: 'p0-override', title: 'P0 source title' },
  );
  reports.push({
    id: 'facebook',
    checkedAt: community.checkedAt,
    attemptedAt: community.checkedAt,
    count: 3,
    status: 'ok',
  });
  const storage = getStorage();
  const urls = [];
  for (const rgb of [
    [23, 101, 77],
    [222, 157, 59],
  ]) {
    const bytes = qaImage(rgb);
    const id = contentHash(bytes);
    await storage.put(id, bytes, 'image/png');
    urls.push('/api/photos/' + id);
  }

  for (const item of items.filter((i) => i.id.startsWith('p0-'))) {
    item.images = urls;
    item.image = urls[0];
    if (item.id !== 'p0-community')
      item.url = item.url.replace(
        '999999999999001',
        item.id === 'p0-hidden' ? '999999999999003' : '999999999999004',
      );
  }
}
const repository = getRepository();
await repository.transaction((state) => {
  for (const item of items)
    if (!state.listings.some((r) => r.id === item.id))
      state.listings.push({
        id: item.id,
        source: item.source,
        payload: item,
        hidden: item.id === 'p0-hidden',
        override: item.id === 'p0-override' ? { title: 'P0 owner correction', price: 5 } : {},
      });
  for (const report of reports)
    if (!state.sources.some((r) => r.id === report.id)) state.sources.push(report);
});
console.log(
  `Selected store initialized (${config.profile}); existing records and corrections preserved.`,
);
