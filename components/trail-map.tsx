'use client';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import { ExternalLink, Maximize } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import type { Listing } from '@/components/winnigo';
import data from '@/lib/data/trail-map.json';
import { resolveMapLocation, collectionLabel, type MapLocation } from '@/lib/trail-locations';

type Entry = { item: Listing; trail: MapLocation };
type MarkerGroup = { entry: Entry; number: number }[];
type LatLng = [number, number];

const MANITOBA_VIEW: { center: LatLng; zoom: number } = { center: [49.9, -97.1], zoom: 7 };
const OVERVIEW_FIT = { padding: [40, 40] as LatLng, maxZoom: 12 };
const ROUTE_STYLE = { color: '#087b69', weight: 4, opacity: 0.85 };
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>';
const DIFFICULTIES = [
  'Any',
  'Easy',
  'Moderate',
  'Challenging',
  'Level 1 / 4',
  'Level 2 / 4',
  'Level 3 / 4',
  'Level 4 / 4',
  'Unknown',
];
const TRAILS_MANITOBA_MAPS =
  'https://www.trailsmanitoba.ca/trail-info/hiking-trails-manitoba-maps/';
// Google My Maps IDs for Trails Manitoba's seasonal maps.
const OFFICIAL_MAP_IDS: Record<string, string> = {
  summer: '19DNqGXcQFtHyzbrP7YwLKv8_Wf-Gtkgy',
  winter: '1HftjxykHeG_JOTFXC2vQIMpUBMeOLY1h',
};

const markerPositions = (entries: Entry[]) =>
  entries.map((entry) => entry.trail.position as LatLng);

/** Route length buckets: short ≤ 5 km, medium 5–15 km, anything else > 15 km. */
function matchesDistance(km: number | null | undefined, bucket: string) {
  if (bucket === 'Any') return true;
  if (km == null) return false;
  if (bucket === 'short') return km <= 5;
  if (bucket === 'medium') return km > 5 && km <= 15;
  return km > 15;
}

/**
 * Draws route lines and numbered markers. Outings at the same point share one marker whose
 * popup lists them; a single outing opens directly.
 */
function addTrailLayers(
  L: typeof Leaflet,
  map: Leaflet.Map,
  entries: Entry[],
  onSelect: (item: Listing) => void,
) {
  const groups = new Map<string, MarkerGroup>();
  entries.forEach(({ item, trail }, index) => {
    if (trail.lines.length)
      L.polyline(trail.lines as Leaflet.LatLngExpression[][], ROUTE_STYLE)
        .on('click', () => onSelect(item))
        .addTo(map);
    const key = trail.position.map((coordinate) => coordinate.toFixed(5)).join(',');
    groups.set(key, [...(groups.get(key) || []), { entry: { item, trail }, number: index + 1 }]);
  });

  groups.forEach((group) => {
    const {
      entry: { item, trail },
      number,
    } = group[0];
    const label = document.createElement('span');
    label.textContent = group.length > 1 ? `${group.length} outings at ${trail.title}` : item.title;
    const marker = L.marker(trail.position as LatLng, {
      title: label.textContent,
      alt: label.textContent,
      icon: L.divIcon({
        className: 'trail-pin' + (trail.approximate ? ' approximate' : ''),
        html: `<span>${group.length > 1 ? group.length + '+' : number}</span>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      }),
    })
      .bindTooltip(label)
      .addTo(map);
    if (group.length === 1) marker.on('click', () => onSelect(item));
    else marker.bindPopup(groupPopup(group, onSelect));
  });
}

/** Popup listing every outing at a shared marker. Built from DOM nodes, never HTML strings. */
function groupPopup(group: MarkerGroup, onSelect: (item: Listing) => void) {
  const list = document.createElement('div');
  list.className = 'map-group-popup';
  for (const { entry, number } of group) {
    const button = document.createElement('button');
    button.textContent = `${number}. ${entry.item.title}`;
    button.addEventListener('click', () => onSelect(entry.item));
    list.appendChild(button);
  }
  return list;
}

/**
 * The Leaflet map. Leaflet is loaded on the client only, and the map is rebuilt whenever the
 * entries change. Animations are disabled so filtering or leaving the tab mid-zoom can't touch
 * a removed map.
 */
function TrailCanvas({
  entries,
  onSelect,
  focusId,
}: {
  entries: Entry[];
  onSelect: (item: Listing) => void;
  focusId: string;
}) {
  const node = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const library = useRef<typeof Leaflet | null>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    setReady(false);
    setError('');
    import('leaflet')
      .then((L) => {
        if (disposed || !node.current) return;
        library.current = L;
        const leafletMap = L.map(node.current, {
          scrollWheelZoom: false,
          zoomAnimation: false,
          fadeAnimation: false,
          markerZoomAnimation: false,
        }).setView(MANITOBA_VIEW.center, MANITOBA_VIEW.zoom);
        map.current = leafletMap;
        L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION })
          .on('tileerror', () => {
            if (!disposed)
              setError(
                'Some map tiles could not load. Trail details and source maps are still available.',
              );
          })
          .addTo(leafletMap);
        addTrailLayers(L, leafletMap, entries, onSelect);
        if (entries.length) leafletMap.fitBounds(markerPositions(entries), OVERVIEW_FIT);
        observer = new ResizeObserver(() => leafletMap.invalidateSize());
        observer.observe(node.current);
        setReady(true);
      })
      .catch(() => {
        if (!disposed)
          setError('The interactive map could not load. Use the trail list or source maps below.');
      });
    return () => {
      disposed = true;
      observer?.disconnect();
      map.current?.stop();
      map.current?.remove();
      map.current = null;
    };
  }, [entries, onSelect]);

  // "Show on map": zoom to the outing's mapped sections, or to its marker.
  useEffect(() => {
    const focused = entries.find((entry) => entry.item.id === focusId);
    if (!focused || !map.current || !library.current) return;
    const points = focused.trail.lines.flat();
    if (points.length)
      map.current.fitBounds(points as LatLng[], { padding: [35, 35], maxZoom: 15 });
    else map.current.setView(focused.trail.position as LatLng, 13);
  }, [focusId, entries, ready]);

  return (
    <div className="trail-canvas-wrap">
      <div className="trail-map-tools">
        <span>{ready ? 'Click a numbered marker to open an outing.' : 'Loading map…'}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={!ready || !entries.length}
          onClick={() => map.current?.fitBounds(markerPositions(entries), OVERVIEW_FIT)}
        >
          <Maximize size={15} /> Fit trails
        </Button>
      </div>
      <div
        ref={node}
        className="trail-canvas"
        role="region"
        aria-label="Interactive Manitoba trail map"
      />
      {error && (
        <p className="notice" role="status">
          {error}
        </p>
      )}
      <p className="map-legend">
        <span className="route-swatch" /> Mapped trail sections <span className="pin-swatch" />{' '}
        Trail or source location <span className="area-swatch" /> Approximate lake, park or
        landmark. Lines may cover only part of an outing.
      </p>
    </div>
  );
}

/**
 * Trail map tab: Winnigo's own map of hiking/cycling listings with distance, difficulty and
 * season filters, plus the embedded official Trails Manitoba maps. Filter changes are reported
 * through `onFilterChange` so the server query matches what the map shows.
 */
export default function TrailMap({
  items,
  onSelect,
  onFilterChange,
}: {
  items: Listing[];
  onSelect: (item: Listing) => void;
  onFilterChange?: (filters: { season: string; difficulty: string; distance: string }) => void;
}) {
  const [distance, setDistance] = useState('Any');
  const [difficulty, setDifficulty] = useState('Any');
  const [trailSeason, setTrailSeason] = useState('Any');
  const [focusId, setFocusId] = useState('');
  // Lives here, not in OfficialMaps, so it survives switching between the two tabs.
  const [officialSeason, setOfficialSeason] = useState('summer');

  useEffect(() => {
    onFilterChange?.({ season: trailSeason, difficulty, distance });
  }, [trailSeason, difficulty, distance, onFilterChange]);

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (trailSeason === 'Any' || item.seasons?.includes(trailSeason)) &&
          (difficulty === 'Any' || (item.difficulty || 'Unknown') === difficulty) &&
          matchesDistance(item.distanceKm, distance),
      ),
    [items, distance, difficulty, trailSeason],
  );
  const entries = useMemo(
    () =>
      filtered.flatMap((item) => {
        const trail = resolveMapLocation(item);
        return trail ? [{ item, trail }] : [];
      }),
    [filtered],
  );
  const unmapped = filtered.filter((item) => !resolveMapLocation(item));

  // Re-setting the same ID would not re-run the zoom effect, so clear it first.
  function showOnMap(id: string) {
    setFocusId('');
    requestAnimationFrame(() => setFocusId(id));
  }

  return (
    <div className="trail-workspace">
      <Tabs defaultValue="winnigo">
        <TabsList aria-label="Map source">
          <TabsTrigger value="winnigo">Winnigo trails</TabsTrigger>
          <TabsTrigger value="manitoba">Trails Manitoba maps</TabsTrigger>
        </TabsList>
        <TabsContent value="winnigo">
          <div className="map-filters">
            <label>
              Distance
              <select value={distance} onChange={(event) => setDistance(event.target.value)}>
                <option value="Any">Any distance</option>
                <option value="short">Up to 5 km</option>
                <option value="medium">Over 5–15 km</option>
                <option value="long">Over 15 km</option>
              </select>
            </label>
            <label>
              Difficulty
              <select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
                {DIFFICULTIES.map((level) => (
                  <option key={level}>{level}</option>
                ))}
              </select>
            </label>
            <label>
              Season
              <select value={trailSeason} onChange={(event) => setTrailSeason(event.target.value)}>
                {['Any', 'Summer', 'Winter'].map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <p aria-live="polite">
              {entries.length} mapped · {unmapped.length} awaiting a location
            </p>
          </div>
          <div className="map-layout">
            <TrailCanvas entries={entries} onSelect={onSelect} focusId={focusId} />
            <div className="map-list" aria-label="Mapped outings">
              {entries.length === 0 && (
                <p className="map-empty">
                  No mapped outings match these filters. Try another category, distance or
                  difficulty.
                </p>
              )}
              {entries.map((entry, index) => (
                <MappedOuting
                  key={entry.item.id}
                  entry={entry}
                  number={index + 1}
                  focused={focusId === entry.item.id}
                  onSelect={onSelect}
                  onShowOnMap={showOnMap}
                />
              ))}
            </div>
          </div>
          {unmapped.length > 0 && (
            <details className="unmapped-trails">
              <summary>{unmapped.length} outings without a confirmed map location</summary>
              <p>
                These remain available in Winnigo. Neither a trail location nor a reliable lake or
                park match is available yet.
              </p>
              {unmapped.map((item) => (
                <button key={item.id} onClick={() => onSelect(item)}>
                  {item.title} <ExternalLink size={14} />
                </button>
              ))}
            </details>
          )}
          <p className="map-credit">
            Open route data:{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              © OpenStreetMap contributors · ODbL
            </a>
            . Trailhead references: Manitoba Trails Project. Official trail points: Trails Manitoba.
            Amber markers show general areas, not confirmed entrances.{' '}
            <a href="/trail-map-data.json" download>
              Download route data
            </a>
            . Checked {data.checkedAt}. Distances and difficulty come from the listings and may
            describe a different route variant.
          </p>
        </TabsContent>
        <TabsContent value="manitoba">
          <OfficialMaps season={officialSeason} onSeasonChange={setOfficialSeason} />
        </TabsContent>
      </Tabs>
      <div className="map-resources">
        <span>More route information</span>
        <a
          href="https://www.manitoba.ca/sd/parks/recreation-and-activities/trails/index.html"
          target="_blank"
          rel="noreferrer"
        >
          Manitoba Parks <ExternalLink size={14} />
        </a>
        <a href="https://www.alltrails.com/canada/manitoba" target="_blank" rel="noreferrer">
          Browse AllTrails <ExternalLink size={14} />
        </a>
      </div>
    </div>
  );
}

/** One row in the list beside the map; its number matches the marker. */
function MappedOuting({
  entry: { item, trail },
  number,
  focused,
  onSelect,
  onShowOnMap,
}: {
  entry: Entry;
  number: number;
  focused: boolean;
  onSelect: (item: Listing) => void;
  onShowOnMap: (id: string) => void;
}) {
  const location = trail.approximate
    ? trail.locationKind + ' · ' + trail.title + ' (approximate)'
    : trail.locationKind;
  const coverage = trail.lines.length ? ' · Mapped sections' : trail.approximate ? '' : ' only';
  return (
    <article className={focused ? 'map-list-item focused' : 'map-list-item'}>
      <span className="map-list-number">{number}</span>
      <div>
        <button className="map-item-title" onClick={() => onSelect(item)}>
          {item.title}
        </button>
        <p>
          {item.distanceKm ? `${item.distanceKm} km` : 'Distance unknown'} ·{' '}
          {item.difficulty || 'Difficulty unknown'}
        </p>
        <span
          className={'collection-label ' + (item.source === 'facebook' ? 'community' : 'official')}
        >
          {collectionLabel(item)}
        </span>
        <p>
          {location}
          {coverage}
        </p>
        <div className="map-item-actions">
          <button onClick={() => onShowOnMap(item.id)}>Show on map</button>
          <button onClick={() => onSelect(item)}>
            {item.source === 'trails-manitoba' ? 'Trail details' : 'Photos & details'}
          </button>
          <a href={trail.sources[0]} target="_blank" rel="noreferrer">
            Map source <ExternalLink size={12} />
          </a>
        </div>
      </div>
    </article>
  );
}

/** Trails Manitoba's own seasonal maps, embedded from Google My Maps. */
function OfficialMaps({
  season,
  onSeasonChange,
}: {
  season: string;
  onSeasonChange: (season: string) => void;
}) {
  return (
    <>
      <div className="official-map-heading">
        <label>
          Season
          <select value={season} onChange={(event) => onSeasonChange(event.target.value)}>
            <option value="summer">Summer</option>
            <option value="winter">Winter</option>
          </select>
        </label>
        <a href={TRAILS_MANITOBA_MAPS} target="_blank" rel="noreferrer">
          Open Trails Manitoba <ExternalLink size={15} />
        </a>
      </div>
      <p className="map-source-description">
        Explore Trails Manitoba’s wider trail network. Use the filters inside their map; Winnigo’s
        listing filters apply only to the Winnigo trails tab.
      </p>
      <iframe
        key={season}
        className="official-trail-map"
        title={`Trails Manitoba ${season} trail map`}
        src={`https://www.google.com/maps/d/embed?mid=${OFFICIAL_MAP_IDS[season]}`}
        loading="lazy"
        allowFullScreen
      />
      <p className="map-credit">
        Map maintained by Trails Manitoba and hosted by Google. If the embedded map is unavailable,{' '}
        <a href={TRAILS_MANITOBA_MAPS} target="_blank" rel="noreferrer">
          open the original page
        </a>
        .
      </p>
    </>
  );
}
