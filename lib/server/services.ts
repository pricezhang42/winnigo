import 'server-only';
import { getRepository, getStorage } from './adapters.mjs';
import type { DiscoveryRepository, PhotoStorage } from './contracts';
export function repository(): DiscoveryRepository {
  return getRepository() as DiscoveryRepository;
}
export function photoStorage(): PhotoStorage {
  return getStorage() as PhotoStorage;
}
