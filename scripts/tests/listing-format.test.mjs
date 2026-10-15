import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const { outputText } = ts.transpileModule(
  readFileSync(new URL('../../components/discovery/listing-format.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext } },
);
const { dateLabel, timeLabel, latestProgramOccurrence } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
);

test('undated activities never imply year-round availability', () => {
  assert.equal(dateLabel({ type: 'Activity' }), 'Check dates with organizer');
  assert.equal(dateLabel({ type: 'Place' }), 'Explore year-round');
  assert.equal(dateLabel({ type: 'Place', schedule: 'unscheduled' }), 'Check dates with organizer');
  assert.match(
    dateLabel({ start: '2026-09-20', end: '2026-11-29', schedule: 'series' }),
    /Select dates$/,
  );
});

test('dated classes display a concise range without raw schedule details', () => {
  const label = dateLabel({
    start: '2026-09-20',
    end: '2026-11-29',
    schedule: 'series',
    yearAssumed: true,
    scheduleText: 'No classes Oct 11 Sundays Ages 9-11',
  });
  assert.match(label, /Sep 20/);
  assert.match(label, /Nov 29/);
  assert.doesNotMatch(label, /No classes|Sundays|Ages|unconfirmed/i);
});

test('closing-month dates show an overall exhibition run without an invented day', () => {
  assert.equal(
    dateLabel({ start: '2026-05-01', endMonth: '2027-04', schedule: 'series' }),
    'May 1, 2026 – Apr 2027',
  );
  assert.equal(dateLabel({ endMonth: '2027-04', schedule: 'series' }), 'Until Apr 2027');
  assert.equal(dateLabel({ schedule: 'series' }), 'Recurring program · Check dates');
});

const program = {
  source: 'manitoba-museum',
  schedule: 'series',
  occurrenceSamples: [
    { start: '2026-11-26T19:00:00-06:00', end: '2026-11-26T20:00:00-06:00', cancelled: false },
    { start: '2026-10-15T19:00:00-05:00', end: '2026-10-15T20:00:00-05:00', cancelled: false },
    { start: '2026-11-27T19:00:00-06:00', end: '2026-11-27T20:00:00-06:00', cancelled: true },
  ],
};

test('recurring Museum programs show latest published active occurrence and Winnipeg time', () => {
  assert.equal(dateLabel(program), 'Nov 26, 2026 · Recurring');
  assert.equal(timeLabel(program), '7:00 p.m. – 8:00 p.m.');
  assert.equal(latestProgramOccurrence(program).start, '2026-11-26T19:00:00-06:00');
  // UTC dates/times are converted to local time, not sliced; October uses daylight time.
  const firstFridays = {
    ...program,
    occurrenceSamples: [{ start: '2026-11-06T22:00:00Z', end: '2026-11-07T03:00:00Z' }],
  };
  assert.equal(dateLabel(firstFridays), 'Nov 6, 2026 · Recurring');
  assert.equal(timeLabel(firstFridays), '4:00 p.m. – 9:00 p.m.');
  assert.equal(
    timeLabel({ ...program, occurrenceSamples: [program.occurrenceSamples[1]] }),
    '7:00 p.m. – 8:00 p.m.',
  );
  assert.equal(program.start, undefined);
  assert.equal(program.end, undefined);
});

test('overall runs and once-only events retain their dates and times', () => {
  const exhibition = { ...program, start: '2026-05-01', endMonth: '2027-04', time: '' };
  assert.equal(dateLabel(exhibition), 'May 1, 2026 – Apr 2027');
  assert.equal(timeLabel(exhibition), '');
  assert.equal(latestProgramOccurrence(exhibition), undefined);
  assert.equal(
    dateLabel({ ...program, start: '2026-09-20', end: '2026-11-29' }),
    'Sep 20 – Nov 29 · Select dates',
  );
  assert.equal(timeLabel({ ...program, schedule: 'event', time: '6–10pm' }), '6–10pm');
  assert.equal(latestProgramOccurrence({ ...program, source: 'wag' }), undefined);
});

test('missing, invalid and cancelled samples have a safe fallback; date-only has no invented time', () => {
  for (const occurrenceSamples of [
    undefined,
    [],
    [{ start: 'bad', end: 'bad' }],
    [program.occurrenceSamples[2]],
  ]) {
    const item = { ...program, occurrenceSamples };
    assert.equal(dateLabel(item), 'Recurring program · Check dates');
    assert.equal(timeLabel(item), '');
  }
  const dayOnly = { ...program, occurrenceSamples: [{ start: '2026-11-06', end: '2026-11-07' }] };
  assert.equal(dateLabel(dayOnly), 'Nov 6, 2026 – Nov 7, 2026 · Recurring');
  assert.equal(timeLabel(dayOnly), '');
});
