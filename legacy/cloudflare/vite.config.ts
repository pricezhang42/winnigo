import vinext from 'vinext';
import {defineConfig,type PluginOption} from 'vite';

export default defineConfig(async({command})=>{
 process.env.CLOUDFLARE_CF_FETCH_ENABLED??='false';
 process.env.WRANGLER_SEND_METRICS??='false';
 const {cloudflare}=await import('@cloudflare/vite-plugin');
 const hosted=process.env.WINNIGO_TARGET==='sites';
 const plugins:PluginOption[]=[vinext()];
 if(hosted){const {sites}=await import('./build/sites-vite-plugin');plugins.push(sites({mockAuth:false}));}
 return {
  server:{host:'127.0.0.1',...(process.env.WINNIGO_POLLING==='1'?{watch:{usePolling:true}}:{})},
  plugins:[...plugins,cloudflare({
   viteEnvironment:{name:'rsc',childEnvironments:['ssr']},inspectorPort:false,
   ...(hosted?{config:{main:'worker.ts',compatibility_flags:['nodejs_compat'],vars:{WINNIGO_AUTH_MODE:'sites'},d1_databases:[{binding:'DB',database_name:'site-creator-d1',database_id:'00000000-0000-4000-8000-000000000000'}],r2_buckets:[{binding:'BUCKET',bucket_name:'site-creator-r2'}]}}:{configPath:'wrangler.json',
    // Vite must serve its CSS/module graph in development. Sending every request
    // to the Worker makes /app/globals.css and /@id/... return app-router 404s.
    // Production keeps run_worker_first=true from wrangler.json.
    ...(command==='serve'?{config:{assets:{binding:'ASSETS',run_worker_first:false}}}:{})
   })
  })]
 };
});
