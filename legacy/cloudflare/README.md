# Legacy Cloudflare release

The complete last pre-P1 release is Git commit `c1c29c5e24ec55de01a99fa776a0879afd191d41`.
The files here are reference configuration, not entry points for the Node application.

To run or build the old app, create a separate checkout of that commit, run its
`npm ci`, `npm run setup`, and `npm run dev` instructions. Its `npm run build:sites`
retains the original Sites packaging. Do not point an experimental checkout at
production storage or change the existing deployment/collector schedule.

The original `.wrangler`, `.dev.vars`, browser profiles and remote site have not
been migrated or deleted. Restore from the complete release rather than mixing
these configuration files with the new Node routes.
