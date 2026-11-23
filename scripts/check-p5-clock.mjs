// P5 checks run in mid-October 2026, so the synthetic November sessions fall in the collection
// window (see fixed-clock.mjs).
import { startClockAt } from './fixed-clock.mjs';
startClockAt('2026-10-14T12:00:00Z');
