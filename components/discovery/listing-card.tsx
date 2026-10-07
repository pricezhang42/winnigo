'use client';
import { ArrowUpRight, Bookmark, CalendarDays, Compass, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { collectionLabel } from '@/lib/trail-locations';
import type { Listing } from '@/lib/domain';
import {
  FORKS_IMAGE,
  LEAF_IMAGE,
  cardPriceLabel,
  dateLabel,
  isCommunityPost,
  usesPlaceholderImage,
} from './listing-format';

type Props = {
  item: Listing;
  saved: boolean;
  onSelect: (item: Listing) => void;
  onToggleSave: (id: string) => void;
};

export function ListingCard({ item, saved, onSelect, onToggleSave }: Props) {
  const collection = collectionLabel(item);
  return (
    <article className="listing-card">
      <div className="card-image">
        <button onClick={() => onSelect(item)} aria-label={'View ' + item.title}>
          {usesPlaceholderImage(item) ? (
            <div className="social-placeholder">
              <Compass size={38} />
              <span>{item.category}</span>
              <small>
                {collection ||
                  (item.provenance === 'municipal'
                    ? 'City of Winnipeg'
                    : 'From the local community')}
              </small>
            </div>
          ) : (
            <img
              src={item.image || FORKS_IMAGE}
              alt={item.image ? item.title : 'The Forks, Winnipeg'}
              loading="lazy"
              onError={(event) => {
                event.currentTarget.src = LEAF_IMAGE;
              }}
            />
          )}
          <span className="type-badge">{item.type}</span>
        </button>
        <Button
          size="icon"
          className={'save-button ' + (saved ? 'is-saved' : '')}
          variant="secondary"
          aria-label={(saved ? 'Unsave ' : 'Save ') + item.title}
          onClick={() => onToggleSave(item.id)}
        >
          <Bookmark size={17} fill={saved ? 'currentColor' : 'none'} />
        </Button>
      </div>
      <div className="card-body">
        {collection && (
          <span
            className={
              'collection-label ' + (item.source === 'facebook' ? 'community' : 'official')
            }
          >
            {collection}
          </span>
        )}
        <div className="card-meta">
          <span>{item.category}</span>
          <span>{cardPriceLabel(item.price)}</span>
        </div>
        <button className="card-title" onClick={() => onSelect(item)}>
          <h3>{item.title}</h3>
        </button>
        <p className="card-date">
          <CalendarDays size={14} />
          {dateLabel(item)}
        </p>
        <p className="card-venue">
          <MapPin size={14} />
          {item.venue}
        </p>
        {item.source === 'winnipeg-free-swim' && <p className="card-date">{item.time}</p>}
        {isCommunityPost(item) && <p className="card-region">{item.neighbourhood}</p>}
        <div className="card-bottom">
          <span>Via {item.sourceName}</span>
          <button aria-label={'Details for ' + item.title} onClick={() => onSelect(item)}>
            <ArrowUpRight size={18} />
          </button>
        </div>
      </div>
    </article>
  );
}
