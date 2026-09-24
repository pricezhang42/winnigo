// Standalone deployments never trust platform identity headers.
export function isOwner(headers,env) {
 if(env.WINNIGO_AUTH_MODE==='local')return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(headers.get('host')||'');
 if(env.WINNIGO_AUTH_MODE==='sites')return !!headers.get('oai-authenticated-user-id')&&!!headers.get('oai-authenticated-user-email');
 if(!env.WINNIGO_ADMIN_PASSWORD||!env.WINNIGO_ADMIN_USER)return false;
 const authorization=headers.get('authorization')||'';
 if(!authorization.startsWith('Basic '))return false;
 try{return atob(authorization.slice(6))===env.WINNIGO_ADMIN_USER+':'+env.WINNIGO_ADMIN_PASSWORD;}catch{return false;}
}
export function isCollector(headers,env){return !!env.WINNIGO_COLLECTOR_KEY&&headers.get('x-winnigo-collector-key')===env.WINNIGO_COLLECTOR_KEY;}
export function mayEnter(request,env){
 if(env.WINNIGO_AUTH_MODE==='local')return ['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname);
 if(env.WINNIGO_AUTH_MODE==='sites')return true; // Existing Sites dispatch enforces the owner-only audience.
 if(isOwner(request.headers,env))return true;
 return request.method==='POST'&&['/api/sources','/api/photos/import'].includes(new URL(request.url).pathname)&&isCollector(request.headers,env);
}
export function authenticationRequired(){return new Response('Winnigo is private. Owner sign-in required.',{status:401,headers:{'WWW-Authenticate':'Basic realm="Winnigo", charset="UTF-8"','Cache-Control':'no-store'}});}
