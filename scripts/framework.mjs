import { fileURLToPath } from 'node:url';
const [command, ...args] = process.argv.slice(2);
if (!['dev', 'build', 'build:sites'].includes(command))
  throw Error('Expected dev, build, or build:sites');
if (command === 'build:sites') process.env.WINNIGO_TARGET = 'sites';
else delete process.env.WINNIGO_TARGET;
const cli = fileURLToPath(new URL('../node_modules/vinext/dist/cli.js', import.meta.url));
process.argv = [
  process.execPath,
  cli,
  command === 'build:sites' ? 'build' : command,
  ...(command === 'dev' ? ['--port', '5173'] : []),
  ...args,
];
await import(cli);
