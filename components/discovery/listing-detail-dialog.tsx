'use client';
import {
  ArrowUpRight,
  Bookmark,
  CalendarDays,
  Compass,
  ExternalLink,
  MapPin,
  Ticket,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import ListingGallery from '@/components/listing-gallery';
import { collectionLabel, resolveMapLocation } from '@/lib/trail-locations';
import type { Listing } from '@/lib/domain';
import {
  FORKS_IMAGE,
  dateLabel,
  detailPriceLabel,
  directionsUrl,
  isCommunityPost,
  isOuting,
  usesPlaceholderImage,
} from './listing-format';

type Props = {
  listing: Listing | null;
  saved: boolean;
  onClose: () => void;
  onToggleSave: (id: string) => void;
};

/** Full details for one listing: photos, facts, discussion notes, trail data and source links. */
export function ListingDetailDialog({ listing, saved, onClose, onToggleSave }: Props) {
  return (
    <Dialog
      open={!!listing}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="detail-dialog">
        {listing && <ListingDetail listing={listing} saved={saved} onToggleSave={onToggleSave} />}
      </DialogContent>
    </Dialog>
  );
}

function ListingDetail({
  listing,
  saved,
  onToggleSave,
}: {
  listing: Listing;
  saved: boolean;
  onToggleSave: (id: string) => void;
}) {
  const collection = collectionLabel(listing);
  const mapLocation = resolveMapLocation(listing);
  const directions = directionsUrl(listing);
  return (
    <>
      {usesPlaceholderImage(listing) ? (
        <div className="social-placeholder detail-image">
          <Compass size={40} />
          <span>{listing.category}</span>
        </div>
      ) : (
        <ListingGallery
          key={listing.id}
          images={listing.images?.length ? listing.images : [listing.image || FORKS_IMAGE]}
          title={listing.title}
          sourceUrl={listing.url}
        />
      )}
      <span className="eyebrow">
        {collection && collection + ' · '}
        {listing.category} · {listing.type}
      </span>
      <DialogTitle className="detail-title">{listing.title}</DialogTitle>
      <DialogDescription>{listing.description}</DialogDescription>
      <div className="detail-facts">
        <p>
          <CalendarDays />
          {dateLabel(listing)}
          {listing.time ? ' · ' + listing.time : ''}
        </p>
        <p>
          <MapPin />
          {listing.address || listing.venue}
          {isCommunityPost(listing) ? ' · ' + listing.neighbourhood : ''}
        </p>
        <p>
          <Ticket />
          {detailPriceLabel(listing.price)}
        </p>
      </div>
      {listing.schedule === 'series' && (
        <p className="notice">
          This listing covers select dates. Check the organizer’s schedule before you go.
        </p>
      )}
      {isOuting(listing) && (
        <div className="outing-facts">
          <p>
            <strong>Distance</strong>
            {listing.distanceKm ? listing.distanceKm + ' km' : 'Not provided'}
          </p>
          <p>
            <strong>Difficulty</strong>
            {listing.difficulty || 'Unknown'}
          </p>
        </div>
      )}
      {!!listing.commentNotes?.length && <CommentNotes notes={listing.commentNotes} />}
      {mapLocation?.approximate && (
        <p className="notice">
          <strong>
            {mapLocation.locationKind}: {mapLocation.title}
          </strong>
          <br />
          This marker shows the general area. The trail entrance and meeting point are not
          confirmed.
        </p>
      )}
      {listing.trailVariants && <OfficialTrailDetails variants={listing.trailVariants} />}
      <div className="detail-actions">
        {listing.facilityUrl && (
          <Button variant="outline" asChild>
            <a href={listing.facilityUrl} target="_blank" rel="noreferrer">
              Pool hours & admission requirements <ExternalLink size={16} />
            </a>
          </Button>
        )}
        <Button asChild>
          <a href={listing.url} target="_blank" rel="noreferrer">
            Visit original listing <ExternalLink size={16} />
          </a>
        </Button>
        <Button variant="outline" onClick={() => onToggleSave(listing.id)}>
          <Bookmark />
          {saved ? 'Saved' : 'Save'}
        </Button>
        {directions && (
          <Button variant="ghost" asChild>
            <a href={directions} target="_blank" rel="noreferrer">
              Directions <ArrowUpRight />
            </a>
          </Button>
        )}
      </div>
      <p className="source-note">
        Source: {listing.sourceName} · {isCommunityPost(listing) ? 'Added' : 'Checked'}{' '}
        {new Date(listing.checkedAt).toLocaleDateString('en-CA')}
        <br />
        Times are local to Winnipeg. Details and availability can change.
      </p>
    </>
  );
}

function CommentNotes({ notes }: { notes: NonNullable<Listing['commentNotes']> }) {
  return (
    <section className="comment-notes">
      <h3>From the discussion</h3>
      <p className="source-note">
        Community-reported details; check the original comments for updates.
      </p>
      {notes.map((note, index) => (
        <div key={index}>
          <p>{note.text}</p>
          <a href={note.url} target="_blank" rel="noreferrer">
            View comment <ExternalLink size={13} />
          </a>
        </div>
      ))}
    </section>
  );
}

/** Seasonal (summer/winter) variants from Trails Manitoba, kept in their original scale. */
function OfficialTrailDetails({ variants }: { variants: NonNullable<Listing['trailVariants']> }) {
  return (
    <section className="official-details">
      <h3>Official trail information</h3>
      <p>
        Trails Manitoba uses a four-level hiking difficulty scale. Map inclusion does not confirm
        current access.
      </p>
      {variants.map((variant, index) => (
        <div key={index}>
          <strong>{variant.season} map</strong>
          <p>
            {[
              variant.primaryActivity,
              variant.trailType,
              variant.distance ? variant.distance + ' km' : 'Distance not provided',
              variant.difficultyLevel
                ? 'Difficulty level ' + Number(variant.difficultyLevel) + ' / 4'
                : 'Difficulty not provided',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {variant.otherUses && <p>Other listed uses: {variant.otherUses}</p>}
          {variant.considerations && <p>Considerations: {variant.considerations}</p>}
          {variant.prohibitedActivities && <p>Restrictions: {variant.prohibitedActivities}</p>}
          <a href={variant.url} target="_blank" rel="noreferrer">
            View {variant.season.toLowerCase()} source map <ExternalLink size={13} />
          </a>
        </div>
      ))}
    </section>
  );
}
