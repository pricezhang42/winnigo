import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const { outputText } = ts.transpileModule(
  readFileSync(new URL('../../components/discovery/listing-format.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext } },
);
const { dateLabel } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
);

test('undated activities never imply year-round availability; class schedules preserve uncertainty', () => {
  assert.equal(dateLabel({ type: 'Activity' }), 'Check dates with organizer');
  assert.equal(dateLabel({ type: 'Place' }), 'Explore year-round');
  assert.equal(dateLabel({ type: 'Place', schedule: 'unscheduled' }), 'Check dates with organizer');
  assert.equal(
    dateLabel({ classOptions: [{ url: 'https://www.wag.ca/event/class-a/' }] }),
    'Multiple dates — see class options',
  );
  const label = dateLabel({
    type: 'Activity',
    dateUncertain: true,
    scheduleText: 'Sep 20 - Nov 29\nSundays · No classes Oct 11',
  });
  assert.match(label, /Sep 20 - Nov 29 Sundays/);
  assert.match(label, /No classes Oct 11 · Year unconfirmed/);
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
