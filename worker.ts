import handler from 'vinext/server/fetch-handler';
import {mayEnter,authenticationRequired} from './lib/auth-policy.mjs';
export default {
 async fetch(request:Request,env:Cloudflare.Env,ctx:ExecutionContext){
  if(!mayEnter(request,env))return authenticationRequired();
  // Compiled CSS and JS belong to the asset binding, not the application router.
  // Authenticate first because production invokes this Worker for every asset.
  if(new URL(request.url).pathname.startsWith('/_next/static/')&&env.ASSETS){
   return env.ASSETS.fetch(request);
  }
  return handler.fetch(request,env,ctx);
 }
};
