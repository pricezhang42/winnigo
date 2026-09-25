// Each independent browser suite starts with fresh limiter state in synthetic QA.
import {loadLocalEnv} from './load-env.mjs';import {database} from '../lib/server/postgres.mjs';
loadLocalEnv();const url=new URL(process.env.DATABASE_URL);if(!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.endsWith('_p3_qa'))throw Error('Synthetic local QA database required');
const pool=database();try{await pool.query('TRUNCATE auth_rate_limit,request_limits');}finally{await pool.end();}
