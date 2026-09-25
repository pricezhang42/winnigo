import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {cp} from 'node:fs/promises';
import {loadLocalEnv} from './load-env.mjs';
import {readConfig} from '../lib/server/config.mjs';
loadLocalEnv();
const [command,...args]=process.argv.slice(2);
if(!['dev','build','start'].includes(command))throw Error('Expected dev, build or start');
for(let i=0;i<args.length;i+=2){
 const name=args[i],value=args[i+1];
 if(!value||!['--port','--hostname'].includes(name)||command==='build')throw Error('Only --port and --hostname overrides are supported.');
 process.env[name==='--port'?'PORT':'WINNIGO_HOST']=value;
}
const config=command==='build'?null:readConfig();
const cli=createRequire(import.meta.url).resolve('next/dist/bin/next');
const options=command==='build'?['--webpack']:['--hostname',config.host,'--port',String(config.port),...(command==='dev'?['--webpack']:[])];
const child=spawn(process.execPath,command==='start'?['.next/standalone/server.js']:[cli,command,...options],{stdio:'inherit',env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',...(config?{HOSTNAME:config.host,PORT:String(config.port),WINNIGO_DATA_DIR:config.dataDir,WINNIGO_MAIL_DIR:resolve(process.env.WINNIGO_MAIL_DIR||'.winnigo/mail')}:{})}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',async(code,signal)=>{
 process.exitCode=code??(signal?1:0);
 if(command==='build'&&code===0)try{await cp('public','.next/standalone/public',{recursive:true});await cp('.next/static','.next/standalone/.next/static',{recursive:true});}catch{console.error('Could not assemble standalone assets.');process.exitCode=1;}
});
