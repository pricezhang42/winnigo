// Synthetic contract examples (model output format v2). No scraped pages, private data or model calls.
export const date = (month, day, year = 2026) => ({ year, month, day });
const pageUrl = 'https://events.example.test/concert';
const showtime = (start, startTime, quote, endTime = null) => ({
  start,
  end: null,
  startTime,
  endTime,
  cancelled: false,
  quote,
});
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
  event: {
    title: 'QA Concert',
    titleQuote: 'QA Concert',
    venue: { name: 'QA Hall', address: null, online: false, quote: 'QA Hall' },
    price: null,
    ticketUrl: null,
    organizerUrl: null,
    imageUrls: [],
    schedule: {
      run: null,
      dates: [showtime(date(11, 20), '19:00', 'November 20, 2026 at 7 PM')],
      recurrence: [],
      hours: [],
      exceptions: [],
    },
    reviewReasons: [],
  },
};
function example(name, text, change) {
  const input = structuredClone(context),
    result = structuredClone(single);
  input.documents[0].text = text;
  change(result.event, input);
  return { name, context: input, result };
}
export const examples = [
  { name: 'single unknown end and price', context, result: single },
  example(
    'multiple dates and same-day showtimes',
    'QA Concert at QA Hall. November 20, 2026 at 7 PM and 9 PM; November 21 at 7 PM.',
    (event) => {
      event.schedule.dates = [
        showtime(date(11, 20), '19:00', 'November 20, 2026 at 7 PM'),
        showtime(date(11, 20), '21:00', 'November 20, 2026 at 7 PM and 9 PM'),
        showtime(date(11, 21), '19:00', 'November 21 at 7 PM'),
      ];
    },
  ),
  example(
    'weekly program across DST',
    'QA Concert at QA Hall. Sundays, October 25 through November 8, 2026, 7–8 PM.',
    (event, input) => {
      input.checkedAt = '2026-10-20T18:00:00Z';
      input.window = { from: '2026-10-01', to: '2026-11-30' };
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
          startTime: '19:00',
          endTime: '20:00',
          quote: 'Sundays, October 25 through November 8, 2026, 7–8 PM',
        },
      ];
    },
  ),
  example(
    'first Friday monthly program',
    'QA Concert at QA Hall. First Friday each month, 7 PM. No ending time or final date stated.',
    (event) => {
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
          startTime: '19:00',
          endTime: null,
          quote: 'First Friday each month, 7 PM',
        },
      ];
    },
  ),
  example(
    'exhibition with weekly closure and holiday exception',
    'QA Concert exhibition at QA Hall. May 1, 2026–April 2027. Gallery hours November 1–December 31, 2026: Tuesday–Sunday, 10 AM–5 PM. Closed Mondays and December 25.',
    (event) => {
      event.titleQuote = 'QA Concert exhibition';
      event.schedule.dates = [];
      event.schedule.run = {
        from: date(5, 1),
        through: date(4, null, 2027),
        quote: 'May 1, 2026–April 2027',
      };
      event.schedule.hours = [
        {
          from: date(11, 1),
          through: date(12, 31),
          weekly: [{ weekdays: [2, 3, 4, 5, 6, 0], startTime: '10:00', endTime: '17:00' }],
          quote: 'Gallery hours November 1–December 31, 2026: Tuesday–Sunday, 10 AM–5 PM',
        },
      ];
      event.schedule.exceptions = [
        {
          from: date(12, 25),
          through: null,
          closed: true,
          intervals: null,
          quote: 'Closed Mondays and December 25',
        },
      ];
    },
  ),
  example(
    'missing year and time',
    'QA Concert at QA Hall. November 20. Time and admission not stated.',
    (event) => {
      event.schedule.dates = [showtime(date(11, 20, null), null, 'November 20')];
    },
  ),
  example(
    'conflicting dates withheld for review',
    'QA Concert at QA Hall. Header says November 20, 2026; booking section says November 21, 2026. Date unconfirmed.',
    (event) => {
      event.schedule.dates = [];
      event.reviewReasons = ['Header and booking dates disagree: November 20 versus November 21.'];
    },
  ),
  example(
    'photo and ticket links',
    'QA Concert at QA Hall. November 20, 2026 at 7 PM. Tickets: https://events.example.test/tickets',
    (event, input) => {
      event.imageUrls = ['https://events.example.test/photos/poster.jpg'];
      event.ticketUrl = 'https://events.example.test/tickets';
      input.documents[0].urls = [event.imageUrls[0], event.ticketUrl];
    },
  ),
];
