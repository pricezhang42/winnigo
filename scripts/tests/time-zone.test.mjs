// Winnipeg time comes from the checked-in zone table (lib/data/time-zone.mjs), not the runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clockLabel,
  dateTimeLabel,
  localParts,
  offsetAt,
  scheduleZone,
  timeLabel,
  zonedInstant,
} from '../../lib/time-zone.mjs';
import { WINNIPEG_TIME_ZONE } from '../../lib/data/time-zone.mjs';

const hours = (iso) => offsetAt(Date.parse(iso)) / 3600000;

test('Winnipeg keeps UTC−5 after 2026-11-01 and used UTC−6 in earlier winters', () => {
  assert.equal(WINNIPEG_TIME_ZONE.zone, 'America/Winnipeg');
  assert.equal(hours('2026-01-15T12:00:00Z'), -6);
  assert.equal(hours('2026-07-01T12:00:00Z'), -5);
  assert.equal(hours('2026-11-28T12:00:00Z'), -5);
  assert.equal(hours('2027-01-15T12:00:00Z'), -5);
  assert.equal(hours('2025-11-28T12:00:00Z'), -6);
});

test('wall times convert both ways, with clock-change gaps and repeats caught', () => {
  // A Manitoba Music show on 2026-11-28 at 8 pm.
  assert.equal(zonedInstant('2026-11-28', '20:00'), '2026-11-29T01:00:00.000Z');
  assert.deepEqual(localParts('2026-11-29T01:00:00.000Z'), { date: '2026-11-28', time: '20:00' });
  assert.equal(zonedInstant('2026-02-01', '19:00'), '2026-02-02T01:00:00.000Z');
  assert.throws(() => zonedInstant('2026-03-08', '02:30'), /does not exist/);
  assert.throws(() => zonedInstant('2025-11-02', '01:30', undefined, { rejectAmbiguous: true }));
  assert.equal(zonedInstant('2025-11-02', '01:30'), '2025-11-02T06:30:00.000Z');
  assert.throws(() => zonedInstant('2026-11-28', '20:00', 'America/Toronto'), /Unsupported/);
});

test('labels and the scheduler zone follow the table', () => {
  assert.equal(clockLabel('2026-11-29T01:00:00.000Z'), '8:00 p.m.');
  assert.equal(clockLabel('2026-11-28T17:30:00.000Z'), '12:30 p.m.');
  assert.equal(
    timeLabel('2026-11-28T15:00:00.000Z', '2026-11-28T23:00:00.000Z'),
    '10:00 a.m. – 6:00 p.m.',
  );
  assert.equal(timeLabel(null, null), '');
  assert.equal(dateTimeLabel('2026-11-29T01:00:00.000Z'), 'Nov 28, 8:00 p.m.');
  assert.equal(scheduleZone(Date.parse('2026-11-23T00:00:00Z')), 'Etc/GMT+5');
  assert.equal(scheduleZone(Date.parse('2025-11-23T00:00:00Z')), 'America/Winnipeg');
});
