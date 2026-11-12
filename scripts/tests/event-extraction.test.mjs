import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventExtractionJsonSchema,
  extractionContextJsonSchema,
  EXTRACTION_LIMITS,
  namedWeekdays,
  parseEventExtraction,
  parseExtractionContext,
  resolveExtractionDate,
} from '../../lib/contracts/event-extraction.mjs';
import { context, single, date, examples } from '../fixtures/event-extraction.mjs';
import { materializeVisitingHours, zonedTimestamp } from '../../lib/event-schedule.mjs';
const copy = () => structuredClone(single);
const parse = (change, input = context) => {
  const value = copy();
  change(value.event, value);
  return parseEventExtraction(value, input);
};
const reject = (change, pattern) => assert.throws(() => parse(change), pattern);
const event = (result) => result.events[0];

test('examples validate without mutation; app supplies source URL, timezone and kind', () => {
  for (const example of examples) {
    const before = structuredClone(example);
    const result = parseEventExtraction(example.result, example.context);
    assert.equal(result.schemaVersion, '3');
    assert.deepEqual(result.issues, [], example.name);
    assert.equal(event(result).sourceUrl, example.context.pageUrl);
    assert.equal(event(result).schedule.timeZone, null);
    assert.deepEqual(example, before);
  }
  const kinds = Object.fromEntries(
    examples.map((e) => [e.name, event(parseEventExtraction(e.result, e.context)).schedule.kind]),
  );
  assert.equal(kinds['single unknown end and price'], 'single');
  assert.equal(kinds['multiple dates and same-day showtimes'], 'multiple');
  assert.equal(kinds['first Friday monthly program'], 'recurring');
  assert.equal(kinds['exhibition with weekly closure and holiday exception'], 'exhibition');
  assert.deepEqual(parseEventExtraction({ event: null }, context).events, []);
});

test('JSON Schema is strict, bounded and omits app-owned fields', () => {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    }
    if (node.type === 'array') assert.equal(typeof node.maxItems, 'number');
    Object.values(node).forEach((v) => (Array.isArray(v) ? v.forEach(visit) : visit(v)));
  };
  for (const schema of [eventExtractionJsonSchema, extractionContextJsonSchema]) {
    assert.match(schema.$schema, /draft-07/);
    visit(schema);
  }
  const names = new Set();
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) Object.keys(node.properties).forEach((k) => names.add(k));
    Object.values(node).forEach((v) => (Array.isArray(v) ? v.forEach(collect) : collect(v)));
  };
  collect(eventExtractionJsonSchema);
  for (const field of [
    'sourceUrl',
    'timeZone',
    'endDayOffset',
    'schemaVersion',
    'description',
    'category',
    'currency',
    'evidence',
    'kind',
  ])
    assert.ok(!names.has(field), field);
});

test('strict types reject unknown fields, omitted fields, coercion and non-finite values', () => {
  reject((e, v) => {
    v.events = [];
  });
  reject((e) => {
    e.sourceUrl = context.pageUrl;
  });
  reject((e) => {
    e.databaseCommand = 'DROP TABLE listings';
  });
  reject((e) => {
    delete e.price;
  });
  reject((e) => {
    e.price = { amount: '10', text: null, quote: 'QA Hall' };
  });
  reject((e) => {
    e.price = { amount: Infinity, text: null, quote: 'QA Hall' };
  });
  reject((e) => {
    e.title = '   ';
  });
});

test('unsupported optional facts become unknown without rejecting the event', () => {
  const result = parse((e) => {
    e.price = { amount: 25, text: '$25', quote: 'Tickets $25' };
    e.venue.address = '1 Invented Street';
  });
  assert.equal(event(result).price, null);
  assert.equal(event(result).venue.address, null);
  assert.equal(event(result).venue.name, 'QA Hall');
  assert.equal(event(result).reviewReasons.length, 0);
  assert.equal(result.issues.length, 1);
  const noVenue = parse((e) => {
    e.venue.quote = 'Invented Hall';
  });
  assert.equal(event(noVenue).venue, null);
  const links = parse((e) => {
    e.ticketUrl = 'https://unpublished.example.test/';
    e.imageUrls = ['https://unpublished.example.test/a.jpg'];
  });
  assert.equal(event(links).ticketUrl, null);
  assert.deepEqual(event(links).images, []);
});

test('unsupported core facts hold the event for review', () => {
  const title = parse((e) => {
    e.titleQuote = 'Invented title';
  });
  assert.equal(event(title).reviewReasons[0].field, '/title');
  const date = parse((e) => {
    e.schedule.dates[0].quote = 'December 1 at 9 PM';
  });
  assert.deepEqual(event(date).schedule.dates, []);
  assert.equal(event(date).reviewReasons[0].reason, 'unsupported schedule entry');
  const spaced = parse((e) => {
    e.schedule.dates[0].quote = '  November 20,\n2026   at 7 PM ';
  });
  assert.equal(event(spaced).reviewReasons.length, 0);
  const apart = structuredClone(context);
  apart.documents[0].text = 'QA Concert at QA Hall.\nNovember 20, 2026\nDoors open early.\n7 PM';
  const split = parse((e) => {
    e.schedule.dates[0].quote = 'November 20, 2026\n7 PM';
  }, apart);
  assert.equal(event(split).reviewReasons.length, 0);
  const elided = parse((e) => {
    e.schedule.dates[0].quote = 'November 20, 2026 … 7 PM';
  }, apart);
  assert.equal(event(elided).reviewReasons.length, 0);
  const halfInvented = parse((e) => {
    e.schedule.dates[0].quote = 'November 20, 2026\n9 PM';
  }, apart);
  assert.match(halfInvented.issues[0], /unsupported schedule entry \(quote:/);
  const model = parse((e) => {
    e.reviewReasons = [
      { field: 'schedule', reason: 'Dates disagree.' },
      { field: 'venue', reason: 'Two postal codes are printed.' },
      { field: 'price', reason: 'Two prices are printed.' },
    ];
  });
  assert.deepEqual(event(model).reviewReasons, [{ field: '/schedule', reason: 'Dates disagree.' }]);
  assert.deepEqual(model.issues, [
    '/venue: Two postal codes are printed.',
    '/price: Two prices are printed.',
  ]);
  for (const field of ['title', 'other'])
    assert.equal(
      event(parse((e) => (e.reviewReasons = [{ field, reason: 'Conflict.' }]))).reviewReasons[0]
        .field,
      '/' + field,
    );
  assert.throws(() => parse((e) => (e.reviewReasons = ['Dates disagree.'])));
  assert.throws(() => parse((e) => (e.reviewReasons = [{ field: 'address', reason: 'x' }])));
});

test('calendar errors hold the entry for review; impossible dates do not become listings', () => {
  for (const fact of [date(2, 30), date(13, 1)]) {
    if (fact.month > 12) {
      reject((e) => {
        e.schedule.dates[0].start = fact;
      });
      continue;
    }
    const result = parse((e) => {
      e.schedule.dates[0].start = fact;
    });
    assert.deepEqual(event(result).schedule.dates, []);
    assert.match(event(result).reviewReasons[0].reason, /invalid calendar date/);
  }
  const reversed = parse((e) => {
    e.schedule.dates[0].end = date(11, 19);
  });
  assert.match(event(reversed).reviewReasons[0].reason, /end precedes/);
  assert.equal(resolveExtractionDate(date(2, 29, 2028), context).value, '2028-02-29');
  assert.equal(resolveExtractionDate(date(4, null, 2027), context).value, '2027-04');
});

test('missing year uses the explicit Winnipeg reference year, with an assumption flag', () => {
  const input = structuredClone(context);
  input.checkedAt = '2027-01-01T02:00:00Z'; // Still December 31 in Winnipeg.
  input.window = { from: '2026-12-01', to: '2027-01-31' };
  assert.deepEqual(resolveExtractionDate(date(12, 31, null), input), {
    value: '2026-12-31',
    precision: 'day',
    yearAssumed: true,
  });
});

test('the app derives day offsets from local times and end dates', () => {
  const slot = (change) => event(parse((e) => change(e.schedule.dates[0]))).schedule.dates[0];
  assert.equal(slot((d) => (d.endTime = '21:00')).endDayOffset, 0);
  assert.equal(slot((d) => (d.endTime = '02:00')).endDayOffset, 1);
  assert.equal(slot(() => {}).endDayOffset, null);
  const multi = slot((d) => Object.assign(d, { end: date(11, 23), endTime: '20:00' }));
  assert.equal(multi.endDayOffset, 3);
  assert.equal(slot((d) => (d.cancelled = true)).status, 'cancelled');
  const exhibition = examples.find((e) => e.name.startsWith('exhibition'));
  const weekly = event(parseEventExtraction(exhibition.result, exhibition.context)).schedule
    .hours[0].weekly[0];
  assert.equal(weekly.endDayOffset, 0);
});

test('recurrence survives DST and monthly selectors remain explicit facts', () => {
  const example = examples.find((e) => e.name === 'weekly program across DST');
  const rule = event(parseEventExtraction(example.result, example.context)).schedule.recurrence[0];
  assert.equal(zonedTimestamp('2026-10-25', rule.startTime), '2026-10-26T00:00:00.000Z');
  assert.equal(zonedTimestamp('2026-11-01', rule.startTime), '2026-11-02T01:00:00.000Z');
  const bad = structuredClone(example.result);
  bad.event.schedule.recurrence[0].weekdays = null;
  const held = event(parseEventExtraction(bad, example.context));
  assert.deepEqual(held.schedule.recurrence, []);
  assert.match(held.reviewReasons[0].reason, /weekly days missing/);
});

test('weekday numbers are described to the model and must match the quoted day', () => {
  const described = JSON.stringify(eventExtractionJsonSchema);
  assert.match(described, /0 = Sunday, 1 = Monday.*6 = Saturday/);
  // Sundays counted from Monday = 0 become 6 (Saturday); the quote says Sunday, so hold it.
  const example = examples.find((e) => e.name === 'weekly program across DST');
  assert.match(example.result.event.schedule.recurrence[0].quote, /Sundays/);
  const shifted = structuredClone(example.result);
  shifted.event.schedule.recurrence[0].weekdays = [6];
  const held = event(parseEventExtraction(shifted, example.context));
  assert.deepEqual(held.schedule.recurrence, []);
  assert.match(held.reviewReasons[0].reason, /weekdays do not match the quoted days/);
  const monthly = examples.find((e) => e.name === 'first Friday monthly program');
  const wrongFriday = structuredClone(monthly.result);
  wrongFriday.event.schedule.recurrence[0].weekdays = [4];
  assert.equal(event(parseEventExtraction(wrongFriday, monthly.context)).reviewReasons.length, 1);
  assert.equal(
    event(parseEventExtraction(monthly.result, monthly.context)).reviewReasons.length,
    0,
  );

  assert.deepEqual([...namedWeekdays('first Sunday of the month')], [0]);
  assert.deepEqual([...namedWeekdays('Open weekdays from noon')], [1, 2, 3, 4, 5]);
  assert.deepEqual([...namedWeekdays('Weekends only')], [0, 6]);
  assert.deepEqual([...namedWeekdays('Tuesday to Sunday')].sort(), [0, 2]);
  // Negated or absent days give no evidence either way.
  for (const quote of ['Closed Mondays', 'daily except Sunday', 'Planetarium sun show', null])
    assert.equal(namedWeekdays(quote), null);
});

test('exhibition maps to shared visiting hours without losing run precision', () => {
  const example = examples.find((e) => e.name.startsWith('exhibition'));
  const extracted = event(parseEventExtraction(example.result, example.context));
  const day = (fact) => resolveExtractionDate(fact, example.context).value;
  const result = materializeVisitingHours(
    {
      timeZone: context.timeZone,
      sourceUrl: extracted.sourceUrl,
      checkedAt: context.checkedAt,
      periods: extracted.schedule.hours.map((p) => ({
        from: day(p.from),
        to: day(p.through),
        weekly: p.weekly.map((s) => ({
          weekdays: s.weekdays,
          opens: s.startTime,
          closes: s.endTime,
        })),
      })),
      exceptions: extracted.schedule.exceptions.map((e) => ({
        from: day(e.from),
        to: day(e.through || e.from),
        closed: e.closed,
      })),
    },
    { source: context.source, url: extracted.sourceUrl, start: '2026-05-01', endMonth: '2027-04' },
    context.window,
  );
  assert.ok(result.occurrences.some((o) => o.start === '2026-11-03'));
  assert.ok(!result.occurrences.some((o) => o.start === '2026-11-02' || o.start === '2026-12-25'));
  assert.equal(extracted.schedule.run.through.day, null);
});

test('image URLs are safe, published and capped at three', () => {
  const example = examples.find((e) => e.name === 'photo and ticket links');
  const parsed = event(parseEventExtraction(example.result, example.context));
  assert.deepEqual(parsed.images, [
    { url: example.result.event.imageUrls[0], kind: 'unknown', caption: null },
  ]);
  assert.equal(parsed.ticketUrl, example.result.event.ticketUrl);
  for (const url of ['http://events.example.test/a.jpg', 'javascript:alert(1)']) {
    const value = structuredClone(example.result);
    value.event.imageUrls = [url];
    assert.throws(() => parseEventExtraction(value, example.context));
  }
  const tooMany = structuredClone(example.result);
  tooMany.event.imageUrls = Array(4).fill(tooMany.event.imageUrls[0]);
  assert.throws(() => parseEventExtraction(tooMany, example.context));
});

test('request context and result limits fail closed without clipping content', () => {
  for (const change of [
    (c) => (c.window.to = '2027-01-01'),
    (c) => (c.checkedAt = 'invalid'),
    (c) => (c.timeZone = 'UTC'),
    (c) => (c.documents = []),
    (c) => (c.documents[0].text = 'a'.repeat(40001)),
    (c) => c.documents.push(c.documents[0]),
  ]) {
    const input = structuredClone(context);
    change(input);
    assert.throws(() => parseExtractionContext(input));
  }
  const huge = copy();
  huge.event.reviewReasons = Array(20).fill({ field: 'other', reason: 'a'.repeat(500) });
  huge.event.schedule.dates = Array(200).fill(huge.event.schedule.dates[0]);
  huge.event.schedule.dates[0] = { ...huge.event.schedule.dates[0], quote: 'a'.repeat(600) };
  assert.ok(JSON.stringify(huge).length < EXTRACTION_LIMITS.resultBytes);
  const tooBig = copy();
  tooBig.event.schedule.dates = Array(201).fill(tooBig.event.schedule.dates[0]);
  assert.throws(() => parseEventExtraction(tooBig, context));
});
