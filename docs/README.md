# Winnigo — Documentation Index

Winnigo is a private, single-owner web app for **discovering Winnipeg events, places, and
outdoor activities**. It collects listings from public Winnipeg calendars and a private
Facebook hiking group, stores them in Cloudflare D1, and presents them through a filterable
discovery UI with an interactive trail map.

This folder documents the project so another engineer or AI agent can take it over. Read the
docs in order if you are new; jump to a specific file if you know what you need.

## Start here

| Doc | What it covers |
| --- | --- |
| [01 — Product overview](01-overview.md) | What Winnigo is, who it's for, current scope and limitations. |
| [02 — Architecture](02-architecture.md) | Tech stack, runtime (vinext / Cloudflare Workers), request lifecycle, D1 + R2 bindings. |
| [03 — Data model](03-data-model.md) | D1 tables, the listing "payload" shape, sources, overrides & hidden state. |
| [04 — Sources & connectors](04-sources-and-connectors.md) | Calendar scrapers, free-swim parser, refresh/dedupe logic, snapshot seeds. |
| [05 — Social & the Facebook collector](05-social-collector.md) | Manual social outings, the Selenium Hiking Manitoba collector, photo import, publish flow. |
| [06 — Frontend](06-frontend.md) | React components, discovery UI, admin desk, trail map. |
| [07 — Development & operations](07-development.md) | Install, dev server, build, D1 migrations, tests, the Sites lifecycle, auth. |
| [08 — Security & privacy](08-security-privacy.md) | Auth model, collector key, private-group constraints, content sanitization rules. |
| [09 — File map](09-file-map.md) | Annotated map of every meaningful file and where logic lives. |
| [10 — Handover notes](10-handover.md) | Conventions, gotchas, known open work, "if you change X, also change Y". |

## Fastest path to running it

```bash
npm run install:ci   # one locked install
npm run dev          # vinext dev server on http://localhost:5173
```

Sign in locally by visiting `/signin-with-chatgpt?return_to=/` (mock auth, portable profile only).
See [07 — Development](07-development.md) for the full workflow.

## Original design conversation

The project was designed in a ChatGPT/Codex session:
`https://chatgpt.com/s/cx_6ab08abcb8808191b83713e6da46212b`
(That link requires the owner's login and could not be fetched while writing these docs, so the
docs are derived entirely from the code and the three root markdown files.)

## Root-level docs (authoritative, keep in sync)

- [`README.md`](../README.md) — the vinext starter/Sites lifecycle reference this project is built on.
- [`WINNIGO.md`](../WINNIGO.md) — the product's own feature/scope/limitations statement.
- [`HIKING-COLLECTOR.md`](../HIKING-COLLECTOR.md) — operating manual for the daily Facebook collector.

These three files are the source of truth for intent. The `docs/` folder explains the code that
implements them.
