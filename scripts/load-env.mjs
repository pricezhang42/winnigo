import {loadEnvFile} from 'node:process';
import {existsSync} from 'node:fs';
// Existing process variables win; loadEnvFile never replaces them.
export function loadLocalEnv(){if(existsSync('.env.local'))loadEnvFile('.env.local');}
