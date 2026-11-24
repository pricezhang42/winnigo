// The extraction check's fixtures are dated November 2026; start its clock on the fixture
// context's date (see fixed-clock.mjs) so discovery does not hide them as past sessions.
import { startClockAt } from './fixed-clock.mjs';
startClockAt('2026-11-06T18:00:00Z');
