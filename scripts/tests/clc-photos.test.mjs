import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectClc,
  parseClcFeed,
  clcPhotoUrl,
  clcCalendarPhotos,
  CLC_FEED,
} from '../../lib/server/canada-life-centre.mjs';
const checkedAt = '2026-10-16T12:00:00Z';
const url = 'https://www.canadalifecentre.ca/calendar-events/show/';
const photo =
  'https://d1kq1f9a6xp251.cloudfront.net/canadalifecentre/wp-content/uploads/2026/10/show.png';
const stored = '/api/photos/' + 'a'.repeat(64);
const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:a\nDTSTART;TZID=America/Winnipeg:20261020T190000\nDTEND;TZID=America/Winnipeg:20261020T210000\nSUMMARY:Show\nURL:${url}\nEND:VEVENT\nEND:VCALENDAR`;
const event = {
  url,
  start: '2026-10-20 19:00:00',
  image_full: [photo],
  image: [photo.replace('.png', '-250x250.png')],
};
const calendar = (events = [event]) => JSON.stringify({ R: 'OK', EVENTS: events });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const fetcher =
  (image = png, events = [event]) =>
  async (u, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(u === CLC_FEED ? feed : u === photo ? image : calendar(events));
  };
test('CLC photos prefer original event artwork; dry runs store no external images', async () => {
  const map = clcCalendarPhotos(calendar());
  assert.deepEqual([...map.values()], [photo]);
  const result = await collectClc({}, checkedAt, { fetchImpl: fetcher() });
  assert.deepEqual(result.items[0].sourceImages, [photo]);
  assert.deepEqual(result.items[0].images, []);
  assert.equal(result.failedPages.length, 0);
});
test('CLC photos use private storage and reuse verified previous references', async () => {
  let writes = 0;
  const result = await collectClc({}, checkedAt, {
    fetchImpl: fetcher(),
    storePhoto: async ({ bytes, contentType }) => {
      assert.deepEqual(bytes, png);
      assert.equal(contentType, 'image/png');
      writes++;
      return stored;
    },
  });
  const item = result.items[0];
  assert.equal(item.image, stored);
  assert.equal(writes, 1);
  const again = await collectClc({}, checkedAt, {
    knownListings: new Map([[item.id, item]]),
    fetchImpl: fetcher('invalid'),
    storePhoto: () => {
      throw Error('Must reuse');
    },
  });
  assert.equal(again.failedPages.length, 0);
  assert.deepEqual(again.items[0].images, [stored]);
});
test('CLC photo failures preserve prior photos and refreshed dates; foreign media are refused', async () => {
  const old = parseClcFeed(feed, checkedAt).items[0];
  old.images = [stored];
  old.image = stored;
  old.sourceImages = [photo.replace('show', 'old')];
  const options = { knownListings: new Map([[old.id, old]]), storePhoto: () => stored };
  for (const fetchImpl of [
    fetcher('not an image'),
    fetcher(png, []),
    fetcher(png, [{ ...event, image_full: ['https://evil.test/a.png'] }]),
    async (u) => new Response(u === CLC_FEED ? feed : 'bad json'),
  ]) {
    const r = await collectClc({}, checkedAt, { ...options, fetchImpl });
    assert.equal(r.failedPages.length, 1);
    assert.deepEqual(r.items[0].images, [stored]);
    assert.deepEqual(r.items[0].sourceImages, old.sourceImages);
    assert.equal(r.items[0].occurrences[0].start, '2026-10-20');
  }
  for (const value of [
    'http://www.canadalifecentre.ca/wp-content/uploads/a.png',
    'https://user@www.canadalifecentre.ca/wp-content/uploads/a.png',
    'https://www.canadalifecentre.ca/private/a.png',
    photo.replace('.png', '.svg'),
  ])
    assert.throws(() => clcPhotoUrl(value), /Refused/);
});
test('CLC series store at most three distinct photos and share downloads between UIDs', async () => {
  const series = feed.replace('END:VEVENT', 'RRULE:FREQ=DAILY;COUNT=5\nEND:VEVENT');
  const events = Array.from({ length: 5 }, (_, i) => ({
    ...event,
    start: `2026-10-${20 + i} 19:00:00`,
    image_full: [photo.replace('show', `show${i}`)],
  }));
  let writes = 0;
  const r = await collectClc({}, checkedAt, {
    fetchImpl: async (u) =>
      new Response(u === CLC_FEED ? series : u.includes('rhc_action') ? calendar(events) : png),
    storePhoto: async () => {
      writes++;
      return stored;
    },
  });
  assert.equal(r.items[0].images.length, 3);
  assert.equal(writes, 3);
  const two = feed.replace(
    'END:VCALENDAR',
    feed
      .slice(feed.indexOf('BEGIN:VEVENT'), feed.indexOf('END:VCALENDAR'))
      .replace('UID:a', 'UID:b') + 'END:VCALENDAR',
  );
  writes = 0;
  const shared = await collectClc({}, checkedAt, {
    fetchImpl: async (u) => new Response(u === CLC_FEED ? two : u === photo ? png : calendar()),
    storePhoto: async () => {
      writes++;
      return stored;
    },
  });
  assert.equal(shared.items.length, 2);
  assert.equal(writes, 1);
});
