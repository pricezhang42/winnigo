The project instructions live in AGENTS.md, shared with other coding tools:

@AGENTS.md

When working from GitHub (`@claude` in an issue or pull request): PostgreSQL, S3 and live sources
are not available, so run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`, and
say which database checks (`check:p2`, `check:p3`, `check:p5`) still need a local run. Never add
secrets, never change production audience or schedules, and keep changes on a branch for review.
