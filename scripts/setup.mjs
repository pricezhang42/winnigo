import {existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
mkdirSync('.winnigo',{recursive:true});
if(!existsSync('.dev.vars')){
 writeFileSync('.dev.vars',`WINNIGO_ADMIN_USER="owner"\nWINNIGO_ADMIN_PASSWORD="${randomBytes(24).toString('hex')}"\nWINNIGO_COLLECTOR_KEY="${randomBytes(32).toString('hex')}"\n`,{mode:0o600});
 console.log('Created private .dev.vars. Use its owner credentials when your browser asks you to sign in.');
}else console.log('Keeping existing .dev.vars credentials.');
