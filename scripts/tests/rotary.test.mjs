// Rotary Club of Winnipeg collector, against saved copies of its pages (scripts/fixtures/pages).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sources } from '../../lib/connectors.mjs';
import { invalidReason } from '../../lib/server/collection.mjs';
import {
  collectRotary,
  parseEventPage,
  parseUpcomingEvents,
  parseWhen,
  posterCandidates,
  readQrCode,
  registrationLocation,
  registrationMatches,
  registrationTimes,
} from '../../lib/server/rotary.mjs';

const fixture = (name) => new URL(`../fixtures/pages/${name}`, import.meta.url);
const page = (name) => readFileSync(fixture(name), 'utf8');
const source = sources.find((candidate) => candidate.id === 'winnipeg-rotary');
const HOME = 'https://winnipegrotary.org/';
const CONCERT =
  'https://winnipegrotary.org/event/end-polio-now---a-concert-for-a-polio-free-world/';
const REMEMBRANCE =
  'https://winnipegrotary.org/event/remembrance-day-service----winnipeg-clubs-united/';
const POSTER =
  'https://clubrunner.blob.core.windows.net/00000000998/Images/End-Polio-now-Concert.-JPG-small.jpg';
const REGISTRATION =
  'https://www.crsadmin.com/eventportal/Registrations/PublicFill/EventPublicFill.aspx?evtid=f16c1919-a498-42c3-bc2d-22a8da706197';

test('the home page box lists the upcoming public events', () => {
  const events = parseUpcomingEvents(page('rotary-home.html'), HOME);
  assert.deepEqual(
    events.map((event) => event.title),
    [
      'End Polio Now - A Concert for a Polio Free World',
      'Remembrance Day Service - Winnipeg Clubs United',
    ],
  );
  assert.equal(
    events[0].url,
    'https://portal.clubrunner.ca/998/Event/end-polio-now---a-concert-for-a-polio-free-world',
  );
  assert.equal(events[0].location, 'First Unitarian Universalist Church');
  assert.deepEqual(parseWhen(events[1].when), {
    start: '2026-11-09',
    end: '2026-11-09',
    time: '6:00 p.m. – 10:00 p.m.',
  });
  assert.deepEqual(posterCandidates(page('rotary-home.html'), HOME), [POSTER]);
});

test('event pages give the ID, date, place, description and small poster, never the contact', () => {
  const concert = parseEventPage(page('rotary-event-concert.html'), CONCERT);
  assert.equal(concert.uid, '2ee20510-e575-42d6-a10f-6701000e1a10');
  assert.equal(concert.venue, 'First Unitarian Universalist Church');
  assert.equal(concert.address, 'First Unitarian Universalist Church, 603 Wellington Cresent, MB');
  assert.match(concert.poster, /crsadmin\.com\/Gen\/Accounts\/998\/EventPlanner\/.+\.jpg$/);
  assert.equal(concert.description, '');
  assert.equal(parseWhen(concert.when).start, '2026-10-24');
  const remembrance = parseEventPage(page('rotary-event-remembrance.html'), REMEMBRANCE);
  assert.equal(remembrance.poster, '');
  assert.match(
    remembrance.description,
    /^Join with Winnipeg clubs for a join remembrance days service/,
  );
  for (const parsed of [concert, remembrance])
    assert.doesNotMatch(JSON.stringify(parsed), /Contact|MemberId|Cosway|Tisdale/);
});

test('a poster QR code is read and its registration page matched by title and date', () => {
  assert.equal(
    readQrCode(readFileSync(fixture('rotary-poster-qr.png'))),
    'https://www.canvaqr.com/RGR13iBOYZ',
  );
  assert.equal(readQrCode(new Uint8Array([1, 2, 3])), null);
  const text = page('rotary-registration.html');
  const concert = {
    title: 'End Polio Now - A Concert for a Polio Free World',
    start: '2026-10-24',
  };
  assert.equal(registrationMatches(text, concert), true);
  assert.equal(registrationMatches(text, { ...concert, start: '2026-10-25' }), false);
  assert.equal(registrationMatches(text, { ...concert, title: 'Remembrance Day Service' }), false);
  assert.equal(registrationTimes(text), 'Doors Open 6:30 pm · Concert 7:00 pm');
  assert.equal(registrationLocation(text), 'First Unitarian Church 603 Wellington Crescent');
});

// Serves the saved pages by URL, the way fetchAllowed would (final URL after redirects).
function savedSite(overrides = {}) {
  const site = {
    [HOME]: { url: HOME, body: page('rotary-home.html') },
    'https://portal.clubrunner.ca/998/Event/end-polio-now---a-concert-for-a-polio-free-world': {
      url: CONCERT,
      body: page('rotary-event-concert.html'),
    },
    'https://portal.clubrunner.ca/998/Event/remembrance-day-service----winnipeg-clubs-united': {
      url: REMEMBRANCE,
      body: page('rotary-event-remembrance.html'),
    },
    [POSTER]: { url: POSTER, body: new Uint8Array(readFileSync(fixture('rotary-poster-qr.png'))) },
    'https://www.canvaqr.com/RGR13iBOYZ': {
      url: REGISTRATION,
      body: page('rotary-registration.html'),
    },
    ...overrides,
  };
  const requested = [];
  const fetchPage = async (url) => {
    requested.push(url);
    if (!site[url]) throw Error('Source returned HTTP 503');
    return site[url];
  };
  return { fetchPage, requested };
}

test('collecting the club lists both events, the full poster and the ticket link', async () => {
  const { fetchPage } = savedSite();
  const result = await collectRotary(source, '2026-10-09T12:00:00Z', { fetchPage, pauseMs: 0 });
  assert.equal(result.items.length, 2);
  assert.equal(result.eventPagesRead, 2);
  assert.equal(result.allowEmpty, true);
  const [concert, remembrance] = result.items;
  for (const item of result.items) assert.equal(invalidReason(item), null);
  assert.equal(concert.id, 'winnipeg-rotary-2ee20510-e575-42d6-a10f-6701000e1a10');
  assert.equal(concert.url, CONCERT);
  assert.equal(concert.start, '2026-10-24');
  assert.equal(concert.image, POSTER); // full-size poster first
  assert.equal(concert.images.length, 2); // then the small copy
  assert.equal(concert.ticketUrl, REGISTRATION);
  assert.equal(concert.time, 'Doors Open 6:30 pm · Concert 7:00 pm');
  assert.equal(concert.address, 'First Unitarian Church 603 Wellington Crescent');
  assert.equal(concert.price, null); // only on the poster image; added by the owner
  assert.match(concert.description, /^See Rotary Club of Winnipeg for the full program/);
  assert.equal(remembrance.image, '');
  assert.equal(remembrance.ticketUrl, undefined);
  assert.equal(remembrance.time, '6:00 p.m. – 10:00 p.m.');
  assert.match(remembrance.description, /^Join with Winnipeg clubs/);
});

test('failures degrade gracefully and the layout check catches a changed home page', async () => {
  // Event page down: the event is still listed from the home page box.
  let site = savedSite({
    'https://portal.clubrunner.ca/998/Event/remembrance-day-service----winnipeg-clubs-united':
      undefined,
  });
  let result = await collectRotary(source, '2026-10-09T12:00:00Z', {
    fetchPage: site.fetchPage,
    pauseMs: 0,
  });
  assert.equal(result.eventPageFailures, 1);
  const remembrance = result.items[1];
  assert.equal(remembrance.start, '2026-11-09');
  assert.equal(remembrance.venue, 'Breezy Bend Golf and Country Club');
  // A QR code that leads somewhere other than an event registration attaches nothing.
  site = savedSite({ 'https://www.canvaqr.com/RGR13iBOYZ': { url: HOME, body: 'Elsewhere' } });
  result = await collectRotary(source, '2026-10-09T12:00:00Z', {
    fetchPage: site.fetchPage,
    pauseMs: 0,
  });
  assert.equal(result.items[0].ticketUrl, undefined);
  assert.match(result.items[0].image, /EventPlanner/);
  // No events is fine; no box at all is a layout change.
  site = savedSite({
    [HOME]: { url: HOME, body: '<div>Upcoming Events</div><ul class="upcoming-event-list"></ul>' },
  });
  result = await collectRotary(source, '2026-10-09T12:00:00Z', {
    fetchPage: site.fetchPage,
    pauseMs: 0,
  });
  assert.deepEqual(result.items, []);
  site = savedSite({ [HOME]: { url: HOME, body: '<p>Maintenance</p>' } });
  await assert.rejects(
    collectRotary(source, '2026-10-09T12:00:00Z', { fetchPage: site.fetchPage, pauseMs: 0 }),
    /Upcoming Events box not found/,
  );
});
