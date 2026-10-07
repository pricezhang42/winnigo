import 'server-only';
import { headers } from 'next/headers';
import { principalFromHeaders } from './server/principal.mjs';
/** The signed-in caller for this request (see lib/server/principal.mjs), or null. */
export async function getPrincipal() {
  return principalFromHeaders(await headers());
}
export async function getOwner() {
  const principal = await getPrincipal();
  return principal?.role === 'owner' ? principal : null;
}
/** The caller if they are the owner or an admin, else null. */
export async function getAdmin() {
  const principal = await getPrincipal();
  return principal && ['owner', 'admin'].includes(principal.role) ? principal : null;
}
