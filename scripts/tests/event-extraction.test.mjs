import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventExtractionJsonSchema,
  extractionContextJsonSchema,
  EXTRACTION_LIMITS,
  parseEventExtraction,
  parseExtractionContext,
  resolveExtractionDate,
} from '../../lib/contracts/event-extraction.mjs';
import { context, single, date, examples } from '../fixtures/event-extraction.mjs';
import { materializeVisitingHours, zonedTimestamp } from '../../lib/event-schedule.mjs';
const copy = () => structuredClone(single);
const reject = (change, pattern) => {
  const value = copy();
  change(value.events[0], value);
  assert.throws(() => parseEventExtraction(value, context), pattern);
};

test('synthetic examples validate without mutating facts or applying defaults', () => {
  for (const example of examples) {
    const before = structuredClone(example);
    assert.deepEqual(
      parseEventExtraction(example.result, example.context),
      example.result,
      example.name,
    );
    assert.deepEqual(example, before);
  }
  assert.equal(parseEventExtraction(single, context).events[0].schedule.timeZone, null);
  assert.deepEqual(parseEventExtraction({ schemaVersion: '1', events: [] }, context).events, []);
});
test('JSON Schema exports strict objects, required nullable fields and bounded arrays', () => {
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
  assert.equal(eventExtractionJsonSchema.properties.events.maxItems, EXTRACTION_LIMITS.events);
});
test('strict types reject unknown fields, omitted fields, coercion and non-finite values', () => {
  reject((e, v) => {
    v.schemaVersion = '2';
  });
  reject((e) => {
    e.databaseCommand = 'DROP TABLE listings';
  });
  reject((e) => {
    e.schedule.complete = true;
  });
  reject((e) => {
    e.venue.override = { hidden: false };
  });
  reject((e) => {
    delete e.price;
  });
  reject((e) => {
    e.price = { amount: '10', currency: 'CAD', text: null };
  });
  reject((e) => {
    e.price = { amount: Infinity, currency: 'CAD', text: null };
  });
  reject((e) => {
    e.title = '   ';
  });
});
test('calendar validation rejects impossible dates, reversed bounds and invalid month precision', () => {
  for (const fact of [date(2, 30), date(2, 29), date(13, 1), date(1, 0)])
    reject((e) => {
      e.schedule.dates[0].start = fact;
    });
  reject((e) => {
    e.schedule.dates[0].start.day = null;
  });
  reject((e) => {
    e.schedule.dates[0].end = date(11, 19);
  }, /end precedes/);
  reject((e) => {
    e.schedule.run = { from: date(11, 20), through: date(10, null) };
  }, /end precedes/);
  assert.equal(resolveExtractionDate(date(2, 29, 2028), context).value, '2028-02-29');
  assert.equal(resolveExtractionDate(date(4, null, 2027), context).value, '2027-04');
  assert.throws(() => resolveExtractionDate(date(2, 30), context), /invalid calendar/);
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
  assert.deepEqual(resolveExtractionDate(date(4, null, 2027), input), {
    value: '2027-04',
    precision: 'month',
    yearAssumed: false,
  });
  assert.equal(input.timeZone, 'America/Winnipeg');
});
test('local times require explicit overnight facts and consistent end dates', () => {
  reject((e) => {
    e.schedule.dates[0].startTime = '25:00';
  });
  reject((e) => {
    e.schedule.dates[0].endTime = '18:00';
    e.schedule.dates[0].endDayOffset = 0;
  }, /reversed local times/);
  reject((e) => {
    e.schedule.dates[0].endDayOffset = 1;
  }, /unknown end time/);
  reject((e) => {
    e.schedule.dates[0].endTime = '20:00';
  }, /explicit day offset/);
  const value = copy(),
    slot = value.events[0].schedule.dates[0];
  Object.assign(slot, { end: date(11, 21), startTime: '23:00', endTime: '01:00', endDayOffset: 1 });
  assert.deepEqual(parseEventExtraction(value, context), value);
  slot.endDayOffset = 0;
  assert.throws(() => parseEventExtraction(value, context), /end date disagrees/);
  Object.assign(slot, { end: date(11, 23), startTime: '19:00', endTime: '20:00', endDayOffset: 3 });
  assert.deepEqual(parseEventExtraction(value, context), value);
});
test('recurrence survives DST and monthly ordinal weekdays remain explicit facts', () => {
  const example = examples.find((e) => e.name === 'weekly program across DST');
  const rule = parseEventExtraction(example.result, example.context).events[0].schedule
    .recurrence[0];
  assert.equal(rule.startTime, '19:00');
  assert.equal(zonedTimestamp('2026-10-25', rule.startTime), '2026-10-26T00:00:00.000Z');
  assert.equal(zonedTimestamp('2026-11-01', rule.startTime), '2026-11-02T01:00:00.000Z');
  const bad = structuredClone(example.result);
  bad.events[0].schedule.recurrence[0].weekdays = null;
  assert.throws(() => parseEventExtraction(bad, example.context), /weekly days missing/);
  const monthly = examples.find((e) => e.name === 'first Friday monthly program');
  assert.equal(
    parseEventExtraction(monthly.result, monthly.context).events[0].schedule.recurrence[0]
      .weekOfMonth,
    1,
  );
  const both = structuredClone(monthly.result);
  both.events[0].schedule.recurrence[0].monthDays = [1];
  assert.throws(() => parseEventExtraction(both, monthly.context), /choose month days/);
});
test('exhibition example maps to shared visiting-hour facts without losing run precision', () => {
  const example = examples.find((e) => e.name.startsWith('exhibition'));
  const extracted = parseEventExtraction(example.result, example.context).events[0];
  const day = (fact) => resolveExtractionDate(fact, example.context).value;
  const schedule = {
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
  };
  const result = materializeVisitingHours(
    schedule,
    { source: context.source, url: extracted.sourceUrl, start: '2026-05-01', endMonth: '2027-04' },
    context.window,
  );
  assert.ok(result.occurrences.some((o) => o.start === '2026-11-03'));
  assert.ok(!result.occurrences.some((o) => o.start === '2026-11-02' || o.start === '2026-12-25'));
  assert.equal(extracted.schedule.run.through.day, null);
  const bad = structuredClone(example.result);
  bad.events[0].schedule.exceptions[0].intervals = [
    { startTime: '10:00', endTime: '17:00', endDayOffset: 0 },
  ];
  assert.throws(() => parseEventExtraction(bad, example.context), /closed interval/);
});
test('evidence must quote supplied material, name existing facts and cover positive fields', () => {
  reject((e) => {
    e.evidence[0].quote = 'Invented quote';
  }, /quote missing/);
  reject((e) => {
    e.evidence[0].sourceUrl = 'https://other.example.test/';
  }, /quote missing/);
  reject((e) => {
    e.evidence[0].fields = ['/missing'];
  }, /unknown fact path/);
  reject((e) => {
    e.evidence[0].fields = ['/evidence'];
  }, /unknown fact path/);
  for (const field of ['/title/length', '/schedule/dates/length', '/schedule/dates/00'])
    reject((e) => {
      e.evidence[0].fields.push(field);
    }, /unknown fact path/);
  reject((e) => {
    e.evidence[0].fields = ['/title'];
  }, /supporting evidence/);
  reject((e) => {
    e.reviewReasons = [{ field: '/missing', reason: 'Unknown' }];
  }, /unknown fact path/);
  reject((e) => {
    e.organizerUrl = 'https://unpublished.example.test/';
  }, /URL not in/);
  reject((e) => {
    e.sourceUrl = 'https://unpublished.example.test/';
  }, /URL not in/);
});
test('photo candidates preserve fallback kind and captions, with safe published URLs and a three-photo cap', () => {
  const example = examples.find((e) => e.name === 'venue photo fallback');
  assert.equal(
    parseEventExtraction(example.result, example.context).events[0].images[0].kind,
    'venue',
  );
  for (const url of [
    'http://events.example.test/photo.jpg',
    'https://user:secret@events.example.test/photo.jpg',
    'javascript:alert(1)',
  ]) {
    const value = structuredClone(example.result);
    value.events[0].images[0].url = url;
    assert.throws(() => parseEventExtraction(value, example.context));
  }
  const tooMany = structuredClone(example.result);
  tooMany.events[0].images = Array(4).fill(tooMany.events[0].images[0]);
  assert.throws(() => parseEventExtraction(tooMany, example.context));
  const invented = structuredClone(example.result);
  invented.events[0].images[0].url += '?invented=1';
  assert.throws(() => parseEventExtraction(invented, example.context), /URL not in/);
});
test('request context and result limits fail closed without clipping content', () => {
  for (const change of [
    (c) => {
      c.window.to = '2027-01-01';
    },
    (c) => {
      c.checkedAt = 'invalid';
    },
    (c) => {
      c.timeZone = 'UTC';
    },
    (c) => {
      c.documents = [];
    },
    (c) => {
      c.documents[0].text = 'a'.repeat(40001);
    },
    (c) => {
      c.documents.push(c.documents[0]);
    },
  ]) {
    const input = structuredClone(context);
    change(input);
    assert.throws(() => parseExtractionContext(input));
  }
  const input = structuredClone(context);
  input.documents = Array.from({ length: 4 }, (_, i) => ({
    url: context.pageUrl + (i || ''),
    text: 'a'.repeat(40000),
    urls: [],
  }));
  assert.throws(() => parseExtractionContext(input), /size limit/);
  assert.throws(() =>
    parseEventExtraction({ schemaVersion: '1', events: Array(51).fill(single.events[0]) }, context),
  );
  const huge = copy();
  huge.events[0].description = 'a'.repeat(EXTRACTION_LIMITS.resultBytes);
  assert.throws(() => parseEventExtraction(huge, context), /size limit/);
});
