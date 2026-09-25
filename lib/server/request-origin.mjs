// Next's internal URL may use localhost/container port while Host retains the
// browser-facing authority. Never accept arbitrary forwarded-host headers.
export function sameOrigin(request,configuredOrigin){
 const origin=request.headers.get('origin');if(!origin)return true;
 if(origin===configuredOrigin)return true;
 try{
  const browser=new URL(origin),internal=new URL(request.url);
  return browser.origin===origin&&browser.protocol===internal.protocol&&browser.host===request.headers.get('host');
 }catch{return false;}
}
