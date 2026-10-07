import { getPrincipal } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export async function GET() {
  const principal = await getPrincipal();
  return principal
    ? Response.json(principal, { headers: { 'Cache-Control': 'no-store' } })
    : Response.json({ error: 'Sign in required' }, { status: 401 });
}
