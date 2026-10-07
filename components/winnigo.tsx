'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  Search,
  MapPin,
  ArrowUpRight,
  Bookmark,
  Compass,
  CalendarDays,
  SlidersHorizontal,
  ArrowRight,
  X,
  Leaf,
  Sun,
  Users,
  Ticket,
  Check,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import TrailMap from '@/components/trail-map';
import { ListingCard } from '@/components/discovery/listing-card';
import { ListingDetailDialog } from '@/components/discovery/listing-detail-dialog';
import { FeatureGrid } from '@/components/discovery/feature-grid';
import { AreaFilterDialog, SourcesDialog } from '@/components/discovery/discovery-dialogs';
import { useSavedListings } from '@/components/discovery/use-saved-listings';
import { useDiscoveryResults, type MapFilters } from '@/components/discovery/use-discovery-results';
import { communitySources } from '@/lib/social.mjs';
import { localDay } from '@/lib/connectors.mjs';
import type { Listing } from '@/lib/domain';
export type { Listing } from '@/lib/domain';

const TABS = ['Explore', 'Events', 'Places', 'Activities', 'Trail map', 'Saved'];
const QUICK_FILTERS = ['Anytime', 'Today', 'This weekend', 'Free', 'Family-friendly', 'Indoors'];
const QUICK_FILTER_ICONS: Record<string, LucideIcon> = {
  'This weekend': CalendarDays,
  Free: Ticket,
  'Family-friendly': Users,
  Indoors: Leaf,
};
const COLLECTIONS = ['All discoveries', 'Community Highlights', 'Official Trails'];
const TRAIL_CATEGORIES = [
  'All',
  'Hiking',
  'Cycling',
  'Winter sports',
  'Water activities',
  'Outdoors',
];
const CATEGORIES = [
  'All',
  'Hiking',
  'Cycling',
  'Arts & culture',
  'Outdoors',
  'Family',
  'Food & drink',
  'Music',
  'Experiences',
  'Winter sports',
  'Water activities',
];
const RESULT_HEADINGS: Record<string, string> = {
  'Trail map': 'Hiking & cycling map',
  Saved: 'Saved for later',
  Places: 'Places worth a visit',
  Activities: 'Get out and try something',
  Events: 'On around town',
};
const DEFAULT_FILTERS = {
  query: '',
  quick: 'Anytime',
  category: 'All',
  area: 'All neighbourhoods',
  collection: 'All discoveries',
};

/** The discovery page: tabs, search and filters, results or trail map, and source details. */
export default function Winnigo() {
  const [tab, setTab] = useState('Explore');
  const [query, setQuery] = useState(DEFAULT_FILTERS.query);
  const [quick, setQuick] = useState(DEFAULT_FILTERS.quick);
  const [category, setCategory] = useState(DEFAULT_FILTERS.category);
  const [area, setArea] = useState(DEFAULT_FILTERS.area);
  const [collection, setCollection] = useState(DEFAULT_FILTERS.collection);
  const [mapFilters, setMapFilters] = useState<MapFilters>({
    season: 'Any',
    difficulty: 'Any',
    distance: 'Any',
  });
  // Number of results already shown; a non-zero offset appends the next page.
  const [offset, setOffset] = useState(0);
  const [today, setToday] = useState(localDay());
  const [selected, setSelected] = useState<Listing | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const { saved, canSave, canImport, toggleSaved } = useSavedListings(() =>
    setNotice('Your browser could not save this list.'),
  );

  useEffect(() => {
    const timer = setInterval(() => setToday(localDay()), 60000);
    return () => clearInterval(timer);
  }, []);

  const { items, total, areas, reports, loading } = useDiscoveryResults(
    {
      query,
      tab,
      quick,
      category,
      area,
      collection,
      offset,
      saved,
      today,
      mapFilters,
    },
    setNotice,
  );

  const changeMapFilters = useCallback((value: MapFilters) => {
    setMapFilters((old) => (JSON.stringify(old) === JSON.stringify(value) ? old : value));
    setOffset(0);
  }, []);

  /** Applies a filter change and restarts from the first page. */
  function update<T>(setter: (value: T) => void, value: T) {
    setter(value);
    setOffset(0);
  }

  function save(id: string) {
    if (!canSave) return;
    if (tab === 'Saved') setOffset(0);
    toggleSaved(id);
  }

  function reset() {
    setOffset(0);
    setQuery(DEFAULT_FILTERS.query);
    setQuick(DEFAULT_FILTERS.quick);
    setCategory(DEFAULT_FILTERS.category);
    setArea(DEFAULT_FILTERS.area);
    setCollection(DEFAULT_FILTERS.collection);
  }

  const showFeatures =
    tab === 'Explore' &&
    !query &&
    quick === DEFAULT_FILTERS.quick &&
    category === DEFAULT_FILTERS.category &&
    collection === DEFAULT_FILTERS.collection;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Winnigo home">
          <span className="brand-icon">
            <Compass size={23} />
          </span>
          winnigo<span className="brand-dot">.</span>
        </a>
        <nav aria-label="Main navigation">
          {TABS.map((name) => (
            <Button
              key={name}
              variant="ghost"
              className={'nav-button ' + (tab === name ? 'active' : '')}
              onClick={() => {
                setTab(name);
                reset();
              }}
            >
              {name === 'Saved' && <Bookmark size={16} />} {name}
              {name === 'Saved' && saved.length > 0 && (
                <span className="count">{saved.length}</span>
              )}
            </Button>
          ))}
        </nav>
        <a href="/account" className="city">
          Account
        </a>
        <span className="city">
          <MapPin size={15} /> Winnipeg, MB
        </span>
      </header>
      <main>
        <Intro tab={tab} />
        <section className="discovery" aria-label="Search and filters">
          <div className="search-row">
            <Search size={21} />
            <Input
              aria-label="Search events, places, or activities"
              placeholder="What are you in the mood for?"
              value={query}
              onChange={(event) => update(setQuery, event.target.value)}
            />
            {query && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Clear search"
                onClick={() => update(setQuery, '')}
              >
                <X />
              </Button>
            )}
            <div className="search-location">
              <MapPin size={17} /> Winnipeg
            </div>
            <Button
              className="filter-button"
              variant="outline"
              onClick={() => setFiltersOpen(true)}
            >
              <SlidersHorizontal size={16} /> Filters
              {area !== DEFAULT_FILTERS.area ? ' •' : ''}
            </Button>
          </div>
          <div className="quick-filters">
            {QUICK_FILTERS.map((name) => {
              const Icon = QUICK_FILTER_ICONS[name];
              return (
                <Button
                  key={name}
                  variant="ghost"
                  className={'chip ' + (quick === name ? 'chosen' : '')}
                  onClick={() => update(setQuick, name)}
                >
                  {Icon ? <Icon /> : null}
                  {name}
                </Button>
              );
            })}
          </div>
        </section>
        {showFeatures && (
          <FeatureGrid
            onShowForks={() => {
              setTab('Places');
              setArea('The Forks');
            }}
            onShowOutdoors={() => setCategory('Outdoors')}
          />
        )}
        <section className="results">
          <div className="results-heading">
            <div>
              <div className="eyebrow">
                {tab === 'Saved' ? 'YOUR COLLECTION' : 'GOOD THINGS ARE HAPPENING'}
              </div>
              <h2>
                {collection !== DEFAULT_FILTERS.collection
                  ? collection
                  : RESULT_HEADINGS[tab] || 'Find your kind of good time'}
              </h2>
            </div>
            <span className="result-count" aria-live="polite">
              {total} {total === 1 ? 'discovery' : 'discoveries'}
              {loading ? ' · Checking sources…' : ''}
            </span>
          </div>
          <div className="collection-filters" aria-label="Listing collection">
            {COLLECTIONS.map((name) => (
              <Button
                key={name}
                variant="outline"
                aria-pressed={collection === name}
                onClick={() => update(setCollection, name)}
              >
                {name}
              </Button>
            ))}
          </div>
          <div className="categories">
            {(tab === 'Trail map' ? TRAIL_CATEGORIES : CATEGORIES).map((name) => (
              <Button
                variant="ghost"
                key={name}
                className={category === name ? 'selected-category' : ''}
                onClick={() => update(setCategory, name)}
              >
                {name}
              </Button>
            ))}
          </div>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {tab === 'Trail map' ? (
            <TrailMap items={items} onSelect={setSelected} onFilterChange={changeMapFilters} />
          ) : (
            <>
              <div className="cards">
                {items.map((item) => (
                  <ListingCard
                    key={item.id}
                    item={item}
                    saved={saved.includes(item.id)}
                    onSelect={setSelected}
                    onToggleSave={save}
                  />
                ))}
              </div>
              {items.length === 0 && (
                <EmptyResults
                  savedTab={tab === 'Saved'}
                  onReset={() => {
                    reset();
                    if (tab === 'Saved') setTab('Explore');
                  }}
                />
              )}
            </>
          )}
          {items.length < total && (
            <div className="load-more">
              <Button variant="outline" disabled={loading} onClick={() => setOffset(items.length)}>
                Show more discoveries <ArrowRight size={16} />
              </Button>
              <p>
                Showing {items.length} of {total}
              </p>
            </div>
          )}
        </section>
        <section className="community-strip">
          <div>
            <span className="eyebrow">HIKING & CYCLING</span>
            <h3>Good company. Great routes.</h3>
            <p>
              Find local outings through community posts. Hiking Manitoba is a private Facebook
              group; membership is required to read its posts.
            </p>
          </div>
          <div className="community-actions">
            <Button variant="outline" asChild>
              <a href={communitySources[0].url} target="_blank" rel="noreferrer">
                Hiking Manitoba <ExternalLink size={16} />
              </a>
            </Button>
            {canImport && (
              <Button variant="ghost" asChild>
                <a href="/admin?add=social">
                  Add a social outing <ArrowUpRight size={16} />
                </a>
              </Button>
            )}
          </div>
        </section>
        <section className="source-strip">
          <div className="source-icon">
            <Check size={22} />
          </div>
          <div>
            <h3>Local sources. One place to look.</h3>
            <p>Collected from Winnipeg calendars, with a link back to every source.</p>
          </div>
          <Button variant="ghost" onClick={() => setSourcesOpen(true)}>
            Meet the sources <ArrowUpRight size={17} />
          </Button>
        </section>
      </main>
      <footer>
        <a className="brand" href="/">
          winnigo<span className="brand-dot">.</span>
        </a>
        <p>Go find your Winnipeg.</p>
        <span>
          Made for the place we call home.{' '}
          <a className="admin-link" href="/admin">
            Manage listings
          </a>
        </span>
      </footer>
      <ListingDetailDialog
        listing={selected}
        saved={!!selected && saved.includes(selected.id)}
        onClose={() => setSelected(null)}
        onToggleSave={save}
      />
      <AreaFilterDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        area={area}
        areas={areas}
        onAreaChange={(value) => update(setArea, value)}
        onReset={reset}
      />
      <SourcesDialog open={sourcesOpen} onOpenChange={setSourcesOpen} reports={reports} />
    </div>
  );
}

function Intro({ tab }: { tab: string }) {
  return (
    <section className="intro">
      <div>
        <div className="eyebrow">YOUR CITY. YOUR NEXT ADVENTURE.</div>
        <h1>
          {tab === 'Trail map' ? (
            'Find your next trail.'
          ) : tab === 'Saved' ? (
            'Good plans, kept close.'
          ) : (
            <>
              A little more <span>Winnipeg.</span>
            </>
          )}
        </h1>
        <p>
          {tab === 'Trail map'
            ? 'Explore Manitoba trails, community reports, and the places they connect.'
            : tab === 'Saved'
              ? 'Your shortlist, saved on this device.'
              : 'Find your next good time. Events, local places, and everything in between.'}
        </p>
      </div>
      <span className="season">
        <Sun size={19} /> Make room for getting out
      </span>
    </section>
  );
}

function EmptyResults({ savedTab, onReset }: { savedTab: boolean; onReset: () => void }) {
  return (
    <div className="empty">
      <Compass size={40} />
      <h3>
        {savedTab ? 'Your next adventure starts here.' : 'No discoveries with these filters.'}
      </h3>
      <p>
        {savedTab
          ? 'Tap the bookmark on a listing to keep it here.'
          : 'Try another date or category. Our collection is still growing.'}
      </p>
      <Button onClick={onReset}>Explore all discoveries</Button>
    </div>
  );
}
