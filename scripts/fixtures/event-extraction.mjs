// Synthetic contract examples. No scraped pages, private data or model calls.
export const date = (month, day, year = 2026) => ({ year, month, day });
const times = (startTime = null, endTime = null, endDayOffset = endTime === null ? null : 0) => ({
  startTime,
  endTime,
  endDayOffset,
});
const occurrence = (start, startTime = null, endTime = null) => ({
  start,
  end: null,
  ...times(startTime, endTime),
  status: null,
});
const pageUrl = 'https://events.example.test/concert';
export const context = {
  schemaVersion: '1',
  source: 'qa-events',
  pageUrl,
  checkedAt: '2026-11-06T18:00:00Z',
  timeZone: 'America/Winnipeg',
  window: { from: '2026-11-01', to: '2026-12-31' },
  documents: [
    {
      url: pageUrl,
      urls: [],
      text: 'QA Concert. November 20, 2026 at 7 PM. QA Hall. Admission not stated.',
    },
  ],
};
export const single = {
  schemaVersion: '1',
  events: [
    {
      sourceUrl: pageUrl,
      title: 'QA Concert',
      description: null,
      category: null,
      status: null,
      venue: { name: 'QA Hall', address: null, mode: null },
      price: null,
      organizerUrl: null,
      ticketUrl: null,
      images: null,
      schedule: {
        kind: 'single',
        timeZone: null,
        run: null,
        dates: [occurrence(date(11, 20), '19:00')],
        recurrence: null,
        hours: null,
        exceptions: null,
      },
      evidence: [
        {
          fields: ['/title', '/venue', '/schedule'],
          sourceUrl: pageUrl,
          quote: context.documents[0].text,
        },
      ],
      reviewReasons: [],
    },
  ],
};
function example(name, quote, change) {
  const input = structuredClone(context),
    result = structuredClone(single);
  input.documents[0].text = quote;
  result.events[0].evidence[0].quote = quote;
  change(result.events[0], input);
  return { name, context: input, result };
}
export const examples = [
  { name: 'single unknown end and price', context, result: single },
  example(
    'multiple dates and same-day showtimes',
    'QA Concert at QA Hall. November 20, 2026 at 7 PM and 9 PM; November 21 at 7 PM.',
    (event) => {
      event.schedule.kind = 'multiple';
      event.schedule.dates.push(
        occurrence(date(11, 20), '21:00'),
        occurrence(date(11, 21), '19:00'),
      );
    },
  ),
  example(
    'weekly program across DST',
    'QA Concert at QA Hall. Sundays, October 25 through November 8, 2026, 7–8 PM.',
    (event, input) => {
      input.checkedAt = '2026-10-20T18:00:00Z';
      input.window = { from: '2026-10-01', to: '2026-11-30' };
      event.schedule.kind = 'recurring';
      event.schedule.dates = [];
      event.schedule.recurrence = [
        {
          frequency: 'weekly',
          interval: 1,
          from: date(10, 25),
          through: date(11, 8),
          weekdays: [0],
          monthDays: null,
          weekOfMonth: null,
          ...times('19:00', '20:00'),
        },
      ];
    },
  ),
  example(
    'first Friday monthly program',
    'QA Concert at QA Hall. First Friday each month, 7 PM. No ending time or final date stated.',
    (event) => {
      event.schedule.kind = 'recurring';
      event.schedule.dates = [];
      event.schedule.recurrence = [
        {
          frequency: 'monthly',
          interval: 1,
          from: null,
          through: null,
          weekdays: [5],
          monthDays: null,
          weekOfMonth: 1,
          ...times('19:00'),
        },
      ];
    },
  ),
  example(
    'exhibition with weekly closure and holiday exception',
    'QA Concert exhibition at QA Hall. May 1, 2026–April 2027. Gallery hours November 1–December 31, 2026: Tuesday–Sunday, 10 AM–5 PM. Closed Mondays and December 25.',
    (event) => {
      event.schedule.kind = 'exhibition';
      event.schedule.dates = [];
      event.schedule.run = { from: date(5, 1), through: date(4, null, 2027) };
      event.schedule.hours = [
        {
          from: date(11, 1),
          through: date(12, 31),
          weekly: [{ weekdays: [2, 3, 4, 5, 6, 0], ...times('10:00', '17:00') }],
        },
      ];
      event.schedule.exceptions = [
        { from: date(12, 25), through: null, closed: true, intervals: null },
      ];
    },
  ),
  example(
    'missing year and time',
    'QA Concert at QA Hall. November 20. Time and admission not stated.',
    (event) => {
      event.schedule.dates = [occurrence(date(11, 20, null))];
    },
  ),
  example(
    'conflicting dates withheld for review',
    'QA Concert at QA Hall. Header says November 20, 2026; booking section says November 21, 2026. Date unconfirmed.',
    (event) => {
      event.schedule.dates = null;
      event.reviewReasons = [
        {
          field: '/schedule/dates',
          reason: 'Header and booking dates disagree: November 20 versus November 21.',
        },
      ];
    },
  ),
  example(
    'venue photo fallback',
    'QA Concert at QA Hall. November 20, 2026 at 7 PM. Featured venue photo: https://events.example.test/photos/venue.jpg',
    (event, input) => {
      event.images = [
        {
          url: 'https://events.example.test/photos/venue.jpg',
          kind: 'venue',
          caption: 'Venue photo supplied by the organizer.',
        },
      ];
      event.evidence[0].fields.push('/images');
      input.documents[0].urls = [event.images[0].url];
    },
  ),
];
