# Winnigo — Documentation Index

Winnigo is a private, single-owner web app for **discovering Winnipeg events, places, and
outdoor activities**. It collects listings from public Winnipeg calendars and a private
Facebook hiking group, stores them in Cloudflare D1, and presents them through a filterable
discovery UI with an interactive trail map.

This folder documents the project so another engineer or AI agent can take it over. Read the
docs in order if you are new; jump to a specific file if you know what you need.

> **Standalone as of commit `8deb589`.** Winnigo used to deploy through ChatGPT Sites with Sign
> in with ChatGPT (SIWC). It is now a **self-contained Cloudflare Workers app** you deploy to your
> own account with `wrangler`, gated by **HTTP Basic auth** — no Codex, Sites plugin, or MCP
> tooling required. See [`AGENTS.md`](../AGENTS.md). The old Sites path survives only as an opt-in
> mode (`WINNIGO_AUTH_MODE=sites`, `npm run build:sites`). Where these docs describe the deploy or
> auth flow, the standalone model is authoritative.

## Start here

**Implementation progress:** [12 — Implementation plan](12-implementation-plan.md) tracks delivery. [13 — P0 baseline](13-p0-baseline.md) records the completed compatibility checks, pinned stack and known map defect.

**Next-version design:** [11 — Target system design](11-target-system-design.md) records the selected Node.js, PostgreSQL and S3-compatible architecture, accounts/preferences, collection pipeline, AI retrieval and migration plan. It is a design, not an implemented migration. Documents 01–10 below describe the current Cloudflare application.

| Doc | What it covers |
| --- | --- |
| [01 — Product overview](01-overview.md) | What Winnigo is, who it's for, current scope and limitations. |
| [02 — Architecture](02-architecture.md) | Tech stack, runtime (vinext / Cloudflare Workers), request lifecycle, D1 + R2 bindings. |
| [03 — Data model](03-data-model.md) | D1 tables, the listing "payload" shape, sources, overrides & hidden state. |
| [04 — Sources & connectors](04-sources-and-connectors.md) | Calendar scrapers, free-swim parser, refresh/dedupe logic, snapshot seeds. |
| [05 — Social & the Facebook collector](05-social-collector.md) | Manual social outings, the Selenium Hiking Manitoba collector, photo import, publish flow. |
| [06 — Frontend](06-frontend.md) | React components, discovery UI, admin desk, trail map. |
| [07 — Development & operations](07-development.md) | Install, setup, dev server, build, deploy (wrangler), D1 migrations, tests, Basic-auth model. |
| [08 — Security & privacy](08-security-privacy.md) | Auth model, collector key, private-group constraints, content sanitization rules. |
| [09 — File map](09-file-map.md) | Annotated map of every meaningful file and where logic lives. |
| [10 — Handover notes](10-handover.md) | Conventions, gotchas, known open work, "if you change X, also change Y". |
| [11 — Target system design](11-target-system-design.md) | Planned Node.js/PostgreSQL/S3 architecture, cloud collectors and extraction, multi-user access, personalization, AI and phased migration. |
| [12 — Implementation plan](12-implementation-plan.md) | Ordered work packages, dependencies, task checklists, acceptance gates and migration/cutover steps. |

## Fastest path to running it

```bash
npm ci               # install (or npm run install:ci)
npm run setup        # generate local .dev.vars (owner + collector credentials) and migrate D1
npm run dev          # vinext dev server on http://localhost:5173
```

When the browser prompts for sign-in, use the owner credentials in the generated `.dev.vars`
(`WINNIGO_ADMIN_USER` / `WINNIGO_ADMIN_PASSWORD`). See [07 — Development](07-development.md) for the
full workflow, including `npm run deploy` to your own Cloudflare account.

## Original design conversation

The project was designed in a ChatGPT/Codex session:
`https://chatgpt.com/s/cx_6ab08abcb8808191b83713e6da46212b`
(That link requires the owner's login and could not be fetched while writing these docs, so the
docs are derived entirely from the code and the three root markdown files.)

## Root-level docs (authoritative, keep in sync)

- [`AGENTS.md`](../AGENTS.md) — the standalone working guide (start/verify, structure, data rules).
- [`README.md`](../README.md) — the app's own setup/deploy reference.
- [`WINNIGO.md`](../WINNIGO.md) — the product's own feature/scope/limitations statement.
- [`HIKING-COLLECTOR.md`](../HIKING-COLLECTOR.md) — operating manual for the daily Facebook collector.

These three files are the source of truth for intent. The `docs/` folder explains the code that
implements them.
