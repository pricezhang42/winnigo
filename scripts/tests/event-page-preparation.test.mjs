import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareExtractionContext,
  prepareExtractionDocument,
} from '../../lib/server/event-page-preparation.mjs';
import { parseEventExtraction } from '../../lib/contracts/event-extraction.mjs';

const url = 'https://events.example.test/calendar/';
const checkedAt = '2027-01-01T02:00:00Z'; // December 31 in Winnipeg.
const prepare = (html, options = {}) => prepareExtractionDocument({ url, html, ...options });
const context = (html, options = {}) =>
  prepareExtractionContext({
    source: 'example-calendar',
    pageUrl: url,
    checkedAt,
    pages: [{ url, html }],
    ...options,
  });
const ld = (value) =>
  `<script type="application/ld+json">${JSON.stringify(value).replaceAll('<', '\\u003c')}</script>`;

test('calendar date attributes and visible showtimes remain separate, including title from an empty link', () => {
  const html = `<main>
    <article id="concert"><header><time datetime="2026-12-31T00:00:00-06:00">Dec <b>31</b></time>
      <h2><a href="../concert/" data-alt-title="Winter Concert"></a></h2></header>
      <div><a href="../hall/">Example Hall</a><span>10 Main Street</span><span>Winnipeg, MB</span></div>
      <span>8:00 PM</span><ul><li>Example Band</li></ul>
    </article><article><h2>Other show</h2></article></main>`;
  const result = prepare(html, { selector: '#concert' });
  assert.match(result.text, /Dec 31 \[HTML datetime: 2026-12-31T00:00:00-06:00\]/);
  assert.match(result.text, /## Winter Concert \(https:\/\/events\.example\.test\/concert\/\)/);
  assert.match(result.text, /\) 10 Main Street Winnipeg, MB/);
  assert.match(result.text, /8:00 PM/);
  assert.match(result.text, /- Example Band/);
  assert.doesNotMatch(result.text, /Other show/);
  assert.deepEqual(result.urls, [
    'https://events.example.test/concert/',
    'https://events.example.test/hall/',
  ]);
  assert.deepEqual(prepare(html, { selector: '#concert' }), result);
  const both = prepare(html, { selector: 'main, article' });
  assert.equal(both.text.split('Winter Concert').length, 2);
  assert.match(both.text, /Example Band\s*\[\/Article\]\s*\[Article\]\s*## Other show/);
});

test('page chrome and configured related sections are dropped while visiting notes and event links survive', () => {
  const html = `<header>Site brand</header><nav>Menu</nav><main><h1>Exhibition</h1>
    <p>May 2026 through April 2027.</p><aside>Closed Mondays and December 25.</aside>
    <section class="related-events"><a href="/related">Unrelated listing</a></section>
    <div class="extra"><a href="/sponsor">Sponsor promotion</a></div>
    <div hidden>Hidden duplicate</div><style>p {color:red}</style><script>tracking()</script>
    <a href="/tickets">Book a visit</a></main><footer>Site footer</footer>`;
  const result = prepare(html, { selector: 'main, .extra a', exclude: '.extra' });
  assert.match(result.text, /May 2026 through April 2027/);
  assert.match(result.text, /Closed Mondays and December 25/);
  assert.doesNotMatch(
    result.text,
    /Site brand|Menu|Unrelated listing|Sponsor promotion|Hidden duplicate|tracking|color:red|Site footer/,
  );
  assert.deepEqual(result.urls, ['https://events.example.test/tickets']);
});

test('schedule tables retain header relationships, merged cells and line breaks without executable attributes', () => {
  const result =
    prepare(`<main><table style="width:100%" onclick="bad()"><caption>Holiday schedule</caption>
    <thead><tr><th id="day" scope="col">Date</th><th id="hours" scope="col">Hours</th></tr></thead>
    <tbody><tr><td headers="day" rowspan="2">December 24</td><td headers="hours">10 AM–noon<br>2 PM–4 PM</td></tr>
    <tr><td headers="hours">Private &amp; group visits</td></tr>
    <tr><td colspan="2">Closed December 25</td></tr></tbody></table></main>`);
  assert.match(result.text, /<caption>Holiday schedule<\/caption>/);
  assert.match(result.text, /<th scope="col" id="day">Date<\/th>/);
  assert.match(result.text, /<td rowspan="2" headers="day">December 24<\/td>/);
  assert.match(result.text, /10 AM–noon<br>2 PM–4 PM/);
  assert.match(result.text, /Private &amp; group visits/);
  assert.match(result.text, /<td colspan="2">Closed December 25<\/td>/);
  assert.doesNotMatch(result.text, /style=|onclick|bad\(\)/);
});

test('keeps relevant inline and matching head event JSON-LD without unrelated entities or contact fields', () => {
  const own = {
    '@type': 'https://schema.org/ExhibitionEvent',
    url,
    name: 'Gallery Show',
    startDate: '2026-12-01',
    endDate: '2027-04',
    description: '<p>Closed Mondays.</p><script>bad()</script>',
    location: { name: 'Gallery', telephone: 'not an event fact' },
    image: '/gallery.jpg',
    eventSchedule: {
      '@type': 'Schedule',
      byDay: ['Tuesday', 'Wednesday'],
      exceptDate: '2026-12-25',
    },
  };
  const unrelated = { '@type': 'MusicEvent', url: '/related', name: 'Other Show' };
  const inline = {
    '@type': ['Thing', 'EventSeries'],
    name: 'Weekly concert',
    subEvent: [
      {
        '@type': 'MusicEvent',
        name: 'Concert',
        startDate: '2026-12-31T20:00:00-06:00',
        url: '/concert',
      },
    ],
  };
  const html = `<head>${ld({ '@graph': [own, unrelated] })}</head><main><h1>Gallery Show</h1>${ld({ mainEntity: { itemListElement: [{ item: inline }] } })}${ld({ '@type': 'Organization', name: 'Unrelated Org' })}<script type="application/ld+json">{bad</script></main>`;
  const result = prepare(html);
  const data = result.text
    .split('Published event data (JSON-LD):\n')[1]
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(data.length, 2);
  const event = data.find((e) => e.name === 'Gallery Show');
  assert.equal(event.endDate, '2027-04');
  assert.equal(event.description, 'Closed Mondays.');
  assert.equal(event.eventSchedule.exceptDate, '2026-12-25');
  assert.equal(event.image, 'https://events.example.test/gallery.jpg');
  assert.equal(event.location.telephone, undefined);
  assert.equal(
    data.find((e) => e.name === 'Weekly concert').subEvent[0].startDate,
    '2026-12-31T20:00:00-06:00',
  );
  assert.doesNotMatch(result.text, /Other Show|Unrelated Org|not an event fact|bad\(\)/);
  assert.ok(result.urls.includes('https://events.example.test/gallery.jpg'));
});

test('normalizes and deduplicates HTTPS links and lazy images using the fetched URL, ignoring unsafe targets and base tags', () => {
  const result = prepare(`<head><base href="https://wrong.example.test/"></head><main>
    <a href="../ticket?a=1&amp;b=2">Tickets</a><a href="../ticket?a=1&amp;b=2">Buy</a>
    <a href="https://user:secret@events.example.test/">Credentials</a><a href="javascript:alert(1)">Invalid</a>
    <a href="#top">Top</a><a href="mailto:owner@example.test">Email</a><a href="http://events.example.test/">HTTP</a>
    <img src="data:image/svg+xml,placeholder" data-src="//img.example.test/event.jpg" alt="Event poster">
  </main>`);
  assert.deepEqual(result.urls, [
    'https://events.example.test/ticket?a=1&b=2',
    'https://img.example.test/event.jpg',
  ]);
  assert.match(result.text, /Image \(Event poster\): https:\/\/img\.example\.test\/event\.jpg/);
  assert.doesNotMatch(result.text, /secret|javascript:|data:image|wrong.example.test|mailto:/);
  assert.throws(
    () =>
      prepareExtractionDocument({
        url: 'https://user:secret@events.example.test/',
        html: '<p>Show</p>',
      }),
    /absolute HTTPS URL/,
  );
});

test('builds the Winnipeg collection window and keeps supporting documents separate for evidence checks', () => {
  const organizer = 'https://organizer.example.test/event/';
  const primary =
    '<main><h1>Winter Concert</h1><a href="https://organizer.example.test/event/">Organizer</a></main>';
  const result = context(primary, {
    pages: [
      { url, html: primary },
      { url: organizer, html: '<main>December 31 at 8 PM.</main>' },
    ],
  });
  assert.deepEqual(result.window, { from: '2026-12-01', to: '2027-01-31' });
  assert.equal(result.timeZone, 'America/Winnipeg');
  assert.equal(result.documents[1].text, 'December 31 at 8 PM.');
  const event = {
    title: 'Winter Concert',
    titleQuote: 'Winter Concert',
    venue: null,
    price: null,
    ticketUrl: null,
    organizerUrl: null,
    imageUrls: [],
    schedule: {
      run: null,
      dates: [
        {
          start: { year: null, month: 12, day: 31 },
          end: null,
          startTime: '20:00',
          endTime: null,
          cancelled: false,
          quote: 'December 31 at 8 PM.',
        },
      ],
      recurrence: [],
      hours: [],
      exceptions: [],
    },
    reviewReasons: [],
  };
  // Quotes may come from a supporting document; the app keeps the main page as the source URL.
  const parsed = parseEventExtraction({ event }, result);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.events[0].sourceUrl, url);
  assert.deepEqual(
    parsed.events[0].evidence.map((e) => [e.sourceUrl, e.quote]),
    [
      [url, 'Winter Concert'],
      [organizer, 'December 31 at 8 PM.'],
    ],
  );
  assert.throws(
    () => context(primary, { pages: [{ url: organizer, html: primary }] }),
    /page document missing/,
  );
  assert.throws(
    () =>
      context(primary, {
        pages: [
          { url, html: primary },
          { url, html: primary },
        ],
      }),
    /duplicate document URL/,
  );
});

test('rejects empty, over-limit or missing page sections without truncation or fallback', () => {
  assert.throws(
    () => prepare('<main>Other</main>', { selector: '#missing' }),
    /matched no content/,
  );
  assert.throws(() => prepare('<main><nav>Menu</nav></main>'), /no usable content/);
  assert.throws(() => prepare('x'.repeat(2_000_001)), /oversized event page HTML/);
  assert.throws(
    () => prepare('<main>' + 'x'.repeat(40_001) + '</main>'),
    /select a smaller region/,
  );
  assert.throws(
    () =>
      prepare(
        '<main>' +
          Array.from({ length: 201 }, (_, i) => `<a href="/event/${i}">Event</a>`).join('') +
          '</main>',
      ),
    /select a smaller region/,
  );
  assert.throws(
    () => prepare(`<main><a href="/${'x'.repeat(2050)}">Long link</a></main>`),
    /URL exceeds contract limits/,
  );
  assert.throws(() => context('', { pages: [] }), /Invalid number of event pages/);
  assert.throws(() => context('Event', { checkedAt: 'invalid' }), /reference timestamp/);
  const pages = Array.from({ length: 4 }, (_, i) => ({
    url: i ? `${url}${i}` : url,
    html: `<main>${'x'.repeat(35_000)}</main>`,
  }));
  assert.throws(() => context('', { pages }), /JSON size limit exceeded/);
});
