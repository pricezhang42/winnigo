import type { Listing } from '../domain';
export type ListingRecord = {
  id: string;
  source: string;
  payload: Listing;
  hidden: boolean;
  override: Partial<Listing>;
};
export type SourceReport = {
  id: string;
  checkedAt: string;
  attemptedAt: string;
  count: number;
  status: string;
  error?: string | null;
};
export type RepositoryState = {
  listings: ListingRecord[];
  sources: SourceReport[];
};
type Principal = { userId: string; role: string };
/** The PostgreSQL repository (lib/server/postgres-repository.mjs) as the web routes use it. */
export interface DiscoveryRepository {
  read(): Promise<RepositoryState>;
  transaction<T>(change: (state: RepositoryState) => T | Promise<T>): Promise<T>;
  health(): Promise<boolean>;
  search(query: Record<string, unknown>): Promise<{
    items: Listing[];
    total: number;
    nextOffset: number | null;
    areas: string[];
    reports: SourceReport[];
  }>;
  availability(id: string, date: string, options?: { principal?: Principal }): Promise<unknown>;
  detail(id: string, options?: { admin?: boolean; principal?: Principal }): Promise<Listing | null>;
}
export interface PhotoStorage {
  get(id: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  put(id: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete(id: string): Promise<void>;
}
