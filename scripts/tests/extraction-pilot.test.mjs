import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFacts, score } from '../lib/extraction-pilot-scoring.mjs';
import { parseEventExtraction } from '../../lib/contracts/event-extraction.mjs';
import { examples } from '../fixtures/event-extraction.mjs';

test('pilot facts credit multiple explicit sessions as recurring, matching shared imports', () => {
  const example = examples.find((e) => e.name === 'multiple dates and same-day showtimes');
  const event = parseEventExtraction(example.result, example.context).events[0];
  assert.equal(modelFacts(event, example.context).recurring, true);
});

test('pilot reports published series bounds before its focused session date', () => {
  const example = examples.find((e) => e.name === 'first Friday monthly program');
  const event = parseEventExtraction(example.result, example.context).events[0];
  const day = { year: 2026, month: 10, day: 2 };
  event.schedule.recurrence[0].from = day;
  event.schedule.dates = [
    { start: { year: 2026, month: 11, day: 6 }, startTime: '17:00', endTime: null },
  ];
  assert.equal(modelFacts(event, example.context).date, '2026-10-02');
});

test('venue scoring tolerates a terminal period but preserves meaningful differences', () => {
  assert.equal(score({ venue: 'QA Hall.' }, { venue: 'QA Hall' }).fields.venue, true);
  assert.equal(score({ venue: 'QA Hall' }, { venue: 'QA Hall, Gallery' }).fields.venue, false);
  assert.equal(score({ title: 'QA Event.' }, { title: 'QA Event' }).fields.title, false);
});

test('a disputed date stays explicitly unknown when only an end is supported', () => {
  const example = examples.find((e) => e.name === 'conflicting dates withheld for review');
  const event = parseEventExtraction(example.result, example.context).events[0];
  event.schedule.run = { from: null, through: { year: 2026, month: 11, day: 20 } };
  const facts = modelFacts(event, example.context);
  assert.equal(facts.date, null);
  assert.equal(facts.endDate, '2026-11-20');
  assert.equal(score({ date: null }, facts).fields.date, true);
});
