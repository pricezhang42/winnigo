import { contentHash } from './s3-storage.mjs';
import { getStorage } from './adapters.mjs';

/** Shared private, content-addressed storage for verified event photo bytes. */
export async function storeEventPhoto({ bytes, contentType }) {
  const id = contentHash(bytes);
  const storage = getStorage();
  if (!(await storage.get(id))) await storage.put(id, bytes, contentType);
  return '/api/photos/' + id;
}
