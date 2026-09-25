import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const value=Number(await readFile(join(process.env.WINNIGO_DATA_DIR||'.winnigo/node','worker-heartbeat'),'utf8'));
if(!Number.isFinite(value)||Date.now()-value>60000)process.exit(1);
