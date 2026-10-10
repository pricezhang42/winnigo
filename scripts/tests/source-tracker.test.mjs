// Keeps docs/sources/candidates.csv valid and in step with the sources defined in code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sources } from '../../lib/connectors.mjs';
import { communitySources } from '../../lib/social.mjs';

const officialTrails = JSON.parse(
  readFileSync(new URL('../../lib/data/official-trails.json', import.meta.url), 'utf8'),
);
const COLUMNS = [
  'id',
  'name',
  'category',
  'kind',
  'content',
  'events_url',
  'feed_type',
  'feed_url',
  'pagination',
  'access',
  'est_listings',
  'status',
  'priority',
  'notes',
  'checked_at',
];
const ALLOWED = {
  category: [
    'attraction',
    'tourism',
    'community',
    'outdoors',
    'library',
    'festival',
    'theatre-music',
    'sport',
    'city-rec',
    'hobby-science',
    'directory',
  ],
  kind: [
    'venue',
    'organization',
    'aggregator',
    'umbrella-directory',
    'community-group',
    'platform',
  ],
  content: ['events', 'places', 'trails', 'activities'],
  feed_type: ['ics', 'jsonld', 'rss', 'api', 'html', 'kml', 'browser', 'manual'],
  pagination: ['none', '?page=N', 'month-nav', 'load-more', 'other'],
  access: ['ok', 'limited', 'blocked', 'unchecked'],
  status: ['candidate', 'approved', 'building', 'live', 'rejected'],
};

/** Minimal RFC 4180 CSV parser: quoted fields may contain commas, quotes ("") and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows.filter((cells) => cells.some((cell) => cell !== ''));
}

const [header, ...lines] = parseCsv(
  readFileSync(new URL('../../docs/sources/candidates.csv', import.meta.url), 'utf8'),
);
const rows = lines.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i]])));

test('the source tracker has the agreed columns and allowed values', () => {
  assert.deepEqual(header, COLUMNS);
  const ids = new Set();
  for (const row of rows) {
    const where = `row ${row.id}`;
    assert.equal(Object.keys(row).length, COLUMNS.length, where);
    assert.match(row.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, where);
    assert.ok(!ids.has(row.id), `${where}: duplicate id`);
    ids.add(row.id);
    assert.ok(row.name.trim(), `${where}: name`);
    for (const [column, values] of Object.entries(ALLOWED))
      assert.ok(values.includes(row[column]), `${where}: ${column}=${row[column]}`);
    for (const column of ['events_url', 'feed_url'])
      if (row[column]) assert.equal(new URL(row[column]).protocol, 'https:', `${where}: ${column}`);
    assert.match(row.est_listings, /^(\d+)?$/, `${where}: est_listings`);
    assert.match(row.checked_at, /^\d{4}-\d{2}-\d{2}$/, `${where}: checked_at`);
    const needsPriority = ['candidate', 'approved', 'building'].includes(row.status);
    assert.match(row.priority, needsPriority ? /^[123]$/ : /^$/, `${where}: priority`);
  }
});

test('live rows match exactly the sources defined in code', () => {
  const defined = [
    ...sources.map((source) => source.id),
    officialTrails.source.id,
    ...communitySources.map((source) => source.id),
  ].sort();
  const live = rows
    .filter((row) => row.status === 'live')
    .map((row) => row.id)
    .sort();
  assert.deepEqual(live, defined);
});
