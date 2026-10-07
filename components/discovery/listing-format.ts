// Display rules shared by listing cards and the detail dialog.
import type { Listing } from '@/lib/domain';

export const FORKS_IMAGE =
  'https://www.travelmanitoba.com/imager/assets_simpleviewinc_com/simpleview/image/upload/crm/manitoba/2014-Aerial_web_9b9f470e-5056-a36f-23871ced5d43ef8f_ae9217944f0738f696c093bccdcb3e55.jpg';
export const LEAF_IMAGE =
  'https://www.assiniboinepark.ca/uploads/public/images/programs-tours/Leaf_Exterior.jpg';

/** Posts added by link or by the browser collector (community outings). */
export const isCommunityPost = (item: Listing) =>
  ['manual', 'browser'].includes(item.provenance || '');

/** Records that carry route distance and difficulty. */
export const isOuting = (item: Listing) =>
  ['manual', 'browser', 'official'].includes(item.provenance || '');

/**
 * Community, official-trail and municipal records without their own photo show an icon
 * placeholder rather than a stock photo that could be mistaken for the place.
 */
export const usesPlaceholderImage = (item: Listing) =>
  ['manual', 'browser', 'official', 'municipal'].includes(item.provenance || '') && !item.image;

/** "Oct 3 – Oct 5", a season note, or a fallback when the source gives no dates. */
export function dateLabel(item: Listing) {
  if (!item.start && item.seasons?.length) return item.seasons.join(' & ') + ' · Check access';
  if (!item.start)
    return item.schedule === 'unscheduled' ? 'Check dates with organizer' : 'Explore year-round';
  const format = (day: string) =>
    new Date(day + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  return (
    format(item.start) +
    (item.end && item.end !== item.start ? ' – ' + format(item.end) : '') +
    (item.schedule === 'series' ? ' · Select dates' : '')
  );
}

/** Short price for cards. `null` means the source did not state a price. */
export function cardPriceLabel(price: Listing['price']) {
  if (price === 0) return 'Free';
  if (price === null) return 'See admission';
  return '$' + price;
}

export function detailPriceLabel(price: Listing['price']) {
  if (price === null) return 'Admission details on the source website';
  if (price === 0) return 'Free admission';
  return '$' + price;
}

/**
 * A Google Maps search for the venue, or null when a community post says its location is
 * unconfirmed (so we never suggest a precise meeting point).
 */
export function directionsUrl(item: Listing) {
  if (isCommunityPost(item) && /not confirmed|to be confirmed|unknown/i.test(item.venue))
    return null;
  const region = isCommunityPost(item)
    ? item.neighbourhood
    : item.source === 'trails-manitoba'
      ? 'Manitoba'
      : 'Winnipeg';
  return (
    'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent(item.venue + ' ' + region)
  );
}
