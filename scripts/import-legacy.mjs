import {loadLocalEnv} from './load-env.mjs';
import {PostgresRepository} from '../lib/server/postgres-repository.mjs';
import {S3Storage} from '../lib/server/s3-storage.mjs';
import {migrateLegacy} from '../lib/server/migrate-legacy.mjs';
loadLocalEnv();const args=process.argv.slice(2),file=args.find(a=>!a.startsWith('--'));if(!file)throw Error('Provide manifest.json [--apply]');
try{console.log(JSON.stringify(await migrateLegacy(file,{repository:new PostgresRepository(),storage:new S3Storage(),apply:args.includes('--apply')}),null,2));}catch(e){console.error('Migration stopped:',e.message);process.exitCode=1;}
