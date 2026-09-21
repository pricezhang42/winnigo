import handler from 'vinext/server/fetch-handler';
import {mayEnter,authenticationRequired} from './lib/auth-policy.mjs';
export default {
 async fetch(request:Request,env:Cloudflare.Env,ctx:ExecutionContext){
  if(!mayEnter(request,env))return authenticationRequired();
  return handler.fetch(request,env,ctx);
 }
};
