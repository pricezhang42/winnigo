import type { MapLocation } from './trail-locations';
export type Occurrence = {
  endTimeKnown?: boolean;
  sourceOverrides?: { title?: string; description?: string; venue?: string };
  id: string;
  basis?: string;
  start: string;
  end: string;
  startAt?: string;
  endAt?: string;
  time: string;
  timeZone: string;
  url: string;
  status: string;
  publishedStart?: string;
  publishedEnd?: string;
  hidden?: boolean;
  override?: Partial<Listing>;
};
export type ScheduleCoverage = {
  basis?: string;
  from: string;
  to: string;
  complete: boolean;
  checkedAt: string;
  sourceUrl?: string;
};
export type VisitingSchedule = {
  timeZone: string;
  sourceUrl: string;
  checkedAt: string;
  periods: {
    from: string;
    to: string;
    weekly: { weekdays: number[]; opens: string; closes: string }[];
  }[];
  exceptions?: {
    from: string;
    to: string;
    closed?: boolean;
    intervals?: { opens: string; closes: string }[];
  }[];
};
export type Listing = {
  eventId?: string;
  occurrenceId?: string;
  eventUrl?: string;
  occurrences?: Occurrence[];
  scheduleCoverage?: ScheduleCoverage[];
  visitingSchedule?: VisitingSchedule;
  visitAvailability?: {
    status: string;
    date: string;
    intervals: Occurrence[];
    hoursKnown?: boolean;
    reason?: string;
  };

  facilityUrl?: string;
  /** Registration or ticket page, when the source publishes one. */
  ticketUrl?: string;
  /** Source wording preserves admission exceptions and audience restrictions. */
  admission?: string;
  audience?: string;
  availability?: 'sold-out' | 'unknown';
  collection?: string;
  activityCategories?: string[];
  seasons?: string[];
  mapLocation?: MapLocation;
  trailVariants?: {
    season: string;
    url: string;
    primaryActivity: string;
    otherUses: string;
    distance: string;
    difficultyLevel: string;
    trailType: string;
    considerations: string;
    prohibitedActivities: string;
  }[];
  id: string;
  title: string;
  type: string;
  category: string;
  venue: string;
  address: string;
  neighbourhood: string;
  start?: string;
  end?: string;
  /** A source-confirmed closing month when no closing day is published. */
  endMonth?: string;
  /** A separate session in a recurring source program. */
  recurring?: boolean;
  seriesId?: string;
  /** Published occurrence timestamps, including timezone offsets (or date-only precision). */
  startAt?: string;
  endAt?: string;
  runDates?: { start?: string; end?: string; endMonth?: string };
  observedFrom?: string;
  observedThrough?: string;
  occurrenceSamples?: {
    url: string;
    start: string;
    end: string;
    cancelled: boolean;
    publishedStart?: string;
    publishedEnd?: string;
  }[];
  time: string;
  image: string;
  url: string;
  sourceName: string;
  source: string;
  checkedAt: string;
  price: number | null;
  family: boolean;
  indoor: boolean;
  description: string;
  schedule: string;
  scheduleText?: string;
  yearAssumed?: boolean;
  parentUrl?: string;
  status: string;
  distanceKm?: number | null;
  difficulty?: string;
  provenance?: string;
  images?: string[];
  commentNotes?: { text: string; url: string }[];
};
