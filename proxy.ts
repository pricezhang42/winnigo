import {NextResponse,type NextRequest} from 'next/server';
import {readConfig} from './lib/server/config.mjs';
import {authenticationRequired} from './lib/auth-policy.mjs';
import {principalFromHeaders} from './lib/server/principal.mjs';
export async function proxy(request:NextRequest){
 const path=request.nextUrl.pathname,config=readConfig();
 if(path==='/api/health')return NextResponse.next();
 // Only the authentication shell and its static assets are public in session mode.
 if(config.mode==='session'&&(path==='/login'||path==='/account/reset'||path.startsWith('/api/auth/')||path.startsWith('/_next/')||['/favicon.ico','/favicon.svg'].includes(path)))return NextResponse.next();
 // Import routes authenticate their service credentials and source scope themselves.
 if(request.method==='POST'&&['/api/sources','/api/photos/import'].includes(path))return NextResponse.next();
 try{if(await principalFromHeaders(request.headers))return NextResponse.next();}catch{return new NextResponse('Authentication unavailable',{status:503});}
 if(config.mode!=='session')return authenticationRequired();
 if(path.startsWith('/api/'))return NextResponse.json({error:'Sign in required'},{status:401,headers:{'Cache-Control':'no-store'}});
 return NextResponse.redirect(new URL('/login',request.url));
}
