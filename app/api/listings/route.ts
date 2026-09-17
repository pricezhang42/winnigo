import {initialize,refreshSources,getCollection} from '@/lib/store';
import listings from '@/lib/data/listings.json';
import sources from '@/lib/data/sources.json';
export const dynamic='force-dynamic';
export async function GET(){try{await initialize();await refreshSources();return Response.json(await getCollection(),{headers:{'Cache-Control':'no-store'}});}catch(error){console.error(error);return Response.json({items:listings,sources,notice:'Showing our last collected listings. Live updates are temporarily unavailable.'},{headers:{'Cache-Control':'no-store'}});}}
