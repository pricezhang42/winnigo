'use client';
import { useEffect, useState } from 'react';
import type { Listing } from '@/lib/domain';

export type SourceReport = {
  id: string;
  name: string;
  url: string;
  count: number;
  status: string;
  checkedAt: string;
};

export type MapFilters = { season: string; difficulty: string; distance: string };

export type DiscoveryRequest = {
  query: string;
  tab: string;
  quick: string;
  category: string;
  area: string;
  collection: string;
  offset: number;
  saved: string[];
  /** Today's Winnipeg date; a new day refetches so finished events drop off. */
  today: string;
  mapFilters: MapFilters;
};

const PAGE_SIZE = '24';

/**
 * Loads a page of listings from `/api/listings` whenever the request changes. A non-zero
 * `offset` appends the next page ("Show more"); otherwise results are replaced. Requests are
 * debounced by 100 ms and superseded requests are aborted. `setNotice` receives the source
 * notice, or an error message when loading fails.
 */
export function useDiscoveryResults(
  request: DiscoveryRequest,
  setNotice: (notice: string) => void,
) {
  const { query, tab, quick, category, area, collection, offset, saved, today, mapFilters } =
    request;
  const [items, setItems] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [areas, setAreas] = useState<string[]>([]);
  const [reports, setReports] = useState<SourceReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({
      query,
      tab,
      quick,
      category,
      area,
      collection,
      offset: String(offset),
      limit: PAGE_SIZE,
      ...(tab === 'Saved' ? { ids: saved.join(',') } : {}),
      ...(tab === 'Trail map' ? mapFilters : {}),
    });
    const timer = setTimeout(
      () =>
        fetch('/api/listings?' + params, { signal: controller.signal })
          .then((response) => {
            if (!response.ok) throw Error();
            return response.json();
          })
          .then((page) => {
            setItems((old) =>
              offset
                ? [
                    ...old,
                    ...page.items.filter((item: Listing) => !old.some((o) => o.id === item.id)),
                  ]
                : page.items,
            );
            setTotal(page.total);
            setAreas(page.areas);
            setReports(page.sources);
            setNotice(page.notice || '');
          })
          .catch((error) => {
            if (error.name !== 'AbortError') {
              setItems([]);
              setTotal(0);
              setNotice('Listings could not be loaded. Please reload to try again.');
            }
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          }),
      100,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // setNotice is a state setter, which React keeps stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tab, quick, category, area, collection, offset, saved, today, mapFilters]);

  return { items, total, areas, reports, loading };
}
