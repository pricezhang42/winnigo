// Event sources. Each entry says where its events are published and how to fetch them; the AI
// extraction pipeline reads every fetched page. Changing an entry changes what Winnigo fetches,
// so entries are reviewed like code. Validation: lib/server/event-sources.mjs. Plan: docs/30.
//
//   status          active | paused (not collected; see notes) | blocked (the site refuses
//                   automated requests; never worked around)
//   schedule        'manual', or a cron expression in America/Winnipeg (registered only with
//                   WINNIGO_SCHEDULES=enabled)
//   fetch.method    pages: list pages link to one page per event
//                   single-page: each list page itself lists several events
//                   browser: pages built with JavaScript (not supported yet)
//   fetch.eventKeyPattern   one capture group; links with the same key are one event
//   fetch.nextLinkPattern   a "next page" link (rel=next, a next class or label) must match it
//   fetch.pageLinkPattern   numbered pagination: every matching list link is read, up to
//                           maxListPages
//   fetch.startUrls         may contain {today} {from} {to} (YYYY-MM-DD) or {fromUnix} {toUnix}: the
//                           collection window, this and next Winnipeg month
//   supportingPages         links on an event page to fetch alongside it: the organizer's own
//                           page, or the same site's series page with every session
//   extraction              per-source token limits for pages that need more room
//   city                    { name, postalPrefixes }: keep only events in that city; events
//                           whose place is not stated stay, flagged for review
//   images.origins          image hosts besides the source's own sites; each event's image is
//                           copied into private storage from these origins only
//
// Patterns are anchored and match a URL's path and query.

/** Organizer sites whose event pages Tourism Winnipeg links to, checked on 2026-11-20. */
const TOURISM_ORGANIZERS = [
  { origin: 'https://manitobamuseum.ca', pattern: '^/series/[^/]+/$' },
  { origin: 'https://www.pte.mb.ca', pattern: '^/performances/[^/]+/?$' },
  { origin: 'https://www.cerclemoliere.com', pattern: '^/en/event/[^/]+/?$' },
  { origin: 'https://canadinns.com', pattern: '^/events/[^/]+/$' },
  { origin: 'https://www.assiniboinepark.ca', pattern: '^/events/event/\\d+/?$' },
  { origin: 'https://childrensmuseum.com', pattern: '^/exhibit/[^/]+/$' },
  // Links to royalaviationmuseum.com redirect to the www host.
  { origin: 'https://royalaviationmuseum.com', pattern: '^/event/[^/]+/$' },
  { origin: 'https://www.royalaviationmuseum.com', pattern: '^/event/[^/]+/$' },
];

// The Events Calendar series pages: the summary block lists every session; the full page is
// too long to send with the event page.
const SERIES_SUMMARY = '.tribe-events-pro-summary';

/** The Events Calendar (WordPress): one link per date, and a series page with every session. */
const eventsCalendar = (origin, listPath, monthPath) => ({
  method: 'pages',
  allowedOrigin: origin,
  startUrls: [origin + listPath],
  eventLinkPattern: '^/event/[^/]+/(?:20\\d\\d-\\d\\d-\\d\\d/(?:\\d+/)?)?$',
  eventKeyPattern: '^/event/([^/]+)/',
  nextLinkPattern: `^${monthPath}20\\d\\d-\\d\\d/$`,
  maxListPages: 2,
  maxEventPages: 60,
});

export const EVENT_SOURCES = [
  {
    id: 'tourism-winnipeg',
    name: 'Tourism Winnipeg',
    status: 'active',
    schedule: 'manual',
    notes:
      'Listing site. Date ranges in its structured data move their start forward to the day ' +
      'the page is read, so the organizer page is fetched when an approved one is linked.',
    fetch: {
      method: 'pages',
      allowedOrigin: 'https://www.tourismwinnipeg.com',
      startUrls: ['https://www.tourismwinnipeg.com/festivals-and-events/upcoming-events'],
      eventLinkPattern: '^/festivals-and-events/upcoming-events/display,event/\\d+(?:/[^/]+)?/?$',
      eventKeyPattern: '^/festivals-and-events/upcoming-events/display,event/(\\d+)',
      nextLinkPattern: '^/festivals-and-events/upcoming-events(?:/page:\\d+)?/?$',
      maxListPages: 15,
      maxEventPages: 150,
      selector: '#content',
    },
    supportingPages: { maxPerPage: 1, sites: TOURISM_ORGANIZERS },
    extraction: { maxInputTokens: 20000 },
  },
  {
    id: 'fortwhyte',
    name: 'FortWhyte Alive',
    status: 'active',
    schedule: 'manual',
    defaultVenue: { name: 'FortWhyte Alive', address: '' },
    notes:
      'Read from the list view: each event page shows a single date and the series pages load ' +
      'their sessions with JavaScript (checked 2026-11-22).',
    fetch: {
      method: 'single-page',
      allowedOrigin: 'https://www.fortwhyte.org',
      startUrls: ['https://www.fortwhyte.org/events/list/'],
      nextLinkPattern: '^/events/list/page/\\d+/$',
      // Entries link /event/<slug>/<date>/; the slug is the event.
      eventKeyPattern: '^/event/([^/]+)/',
      maxListPages: 12,
    },
    extraction: { maxOutputTokens: 16384 },
  },
  {
    id: 'canada-life-centre',
    name: 'Canada Life Centre',
    status: 'active',
    schedule: 'manual',
    defaultVenue: { name: 'Canada Life Centre', address: '' },
    fetch: {
      method: 'pages',
      allowedOrigin: 'https://www.canadalifecentre.ca',
      // The calendar page loads its events from this request (JSON with each event's link),
      // limited to the collection window.
      startUrls: [
        'https://www.canadalifecentre.ca/?rhc_action=get_calendar_events&post_type%5B%5D=events' +
          '&taxonomy=calendar&terms=events%2Cjets_events%2Cmoose_events%2Csea_bears' +
          '&start={fromUnix}&end={toUnix}&view=month',
      ],
      eventLinkPattern: '^/calendar-events/[^/]+/$',
      maxListPages: 1,
      maxEventPages: 60,
    },
    images: { origins: ['https://d1kq1f9a6xp251.cloudfront.net'] },
  },
  {
    id: 'manitoba-museum',
    name: 'Manitoba Museum',
    status: 'active',
    schedule: 'manual',
    defaultVenue: { name: 'Manitoba Museum', address: '190 Rupert Avenue, Winnipeg' },
    fetch: eventsCalendar('https://manitobamuseum.ca', '/whats-on/', '/whats-on/month/'),
    supportingPages: {
      maxPerPage: 1,
      sites: [
        {
          origin: 'https://manitobamuseum.ca',
          pattern: '^/series/[^/]+/$',
          selector: SERIES_SUMMARY,
        },
      ],
    },
    extraction: { maxInputTokens: 20000 },
  },
  {
    id: 'wag',
    name: 'WAG–Qaumajuq',
    status: 'blocked',
    schedule: 'manual',
    notes: 'wag.ca answers automated requests with HTTP 403 (checked 2026-11-21).',
    defaultVenue: { name: 'WAG–Qaumajuq', address: '300 Memorial Boulevard, Winnipeg' },
    fetch: {
      method: 'pages',
      allowedOrigin: 'https://www.wag.ca',
      startUrls: ['https://www.wag.ca/events/event-calendar/'],
      eventLinkPattern: '^/event/[^/]+/?$',
      maxListPages: 1,
      maxEventPages: 60,
    },
  },
  {
    id: 'manitoba-music',
    name: 'Manitoba Music',
    status: 'active',
    schedule: 'manual',
    fetch: {
      method: 'pages',
      allowedOrigin: 'https://www.manitobamusic.com',
      startUrls: ['https://www.manitobamusic.com/livemusic/from:{today}'],
      eventLinkPattern: '^/livemusic/display,event/\\d+(?:/[^/]+)?/?$',
      eventKeyPattern: '^/livemusic/display,event/(\\d+)',
      pageLinkPattern: '^/livemusic/from:\\d{4}-\\d\\d-\\d\\d/page:\\d+$',
      maxListPages: 6,
      maxEventPages: 150,
    },
  },
  {
    id: 'winnipeg-free-swim',
    name: 'City of Winnipeg · Free swim',
    status: 'active',
    schedule: '0 6,15 * * *',
    notes: 'Pool closures on the indoor pool pages are not read yet.',
    fetch: {
      method: 'single-page',
      allowedOrigin: 'https://www.winnipeg.ca',
      startUrls: ['https://www.winnipeg.ca/recreation-leisure/pools/swimming/free-swim'],
      maxListPages: 1,
      selector: 'main',
    },
    extraction: { maxOutputTokens: 16384 },
  },
  {
    id: 'forks',
    name: 'The Forks',
    status: 'active',
    schedule: '0 6 * * *',
    defaultVenue: { name: 'The Forks', address: 'The Forks, Winnipeg' },
    fetch: {
      method: 'single-page',
      allowedOrigin: 'https://www.theforks.com',
      startUrls: ['https://www.theforks.com/events/calendar-of-events'],
      nextLinkPattern: '^/events/calendar-of-events/list/20\\d\\d/\\d\\d$',
      maxListPages: 2,
      selector: 'main',
    },
    extraction: { maxOutputTokens: 16384 },
  },
  {
    id: 'park',
    name: 'Assiniboine Park',
    status: 'active',
    schedule: '0 6 * * *',
    defaultVenue: { name: 'Assiniboine Park', address: 'Assiniboine Park, Winnipeg' },
    fetch: {
      method: 'pages',
      allowedOrigin: 'https://www.assiniboinepark.ca',
      startUrls: ['https://www.assiniboinepark.ca/events'],
      // Zoo Lights and TROLLS have their own pages outside /events/event/.
      eventLinkPattern: '^(?:/events/event/\\d+|/events/zoolights|/trolls)/?$',
      nextLinkPattern: '^/events/events/20\\d\\d/\\d\\d/?$',
      maxListPages: 2,
      maxEventPages: 60,
    },
  },
  {
    id: 'manitoba',
    name: 'Travel Manitoba',
    status: 'active',
    schedule: '0 6 * * *',
    notes: 'Province-wide listing; events outside Winnipeg are dropped after extraction.',
    city: { name: 'Winnipeg', postalPrefixes: ['R2', 'R3'] },
    fetch: {
      method: 'pages',
      allowedOrigin: 'https://www.travelmanitoba.com',
      startUrls: ['https://www.travelmanitoba.com/events/'],
      eventLinkPattern: '^/events/(?!submit/)[a-z0-9-]+/$',
      maxListPages: 1,
      maxEventPages: 100,
    },
  },
  {
    id: 'winnipeg-rotary',
    name: 'Rotary Club of Winnipeg',
    status: 'paused',
    schedule: 'manual',
    notes:
      'Events are published as poster images with QR codes. Text extraction cannot read them; ' +
      'this needs image input to the model.',
    fetch: {
      method: 'single-page',
      allowedOrigin: 'https://winnipegrotary.org',
      startUrls: ['https://winnipegrotary.org/998/'],
      maxListPages: 1,
    },
  },
];
