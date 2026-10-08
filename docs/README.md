# Winnigo — Documentation Index

Winnigo now runs on standard Next.js/Node.js. P2 provides PostgreSQL/S3 storage; P3 provides invitation-only accounts and content permissions. The original Cloudflare site and data remain unchanged.

Start with the root [README](../README.md), [implementation plan](12-implementation-plan.md), and [P1 acceptance record](14-p1-foundation.md). **Documents 01–10 describe the legacy release**, not the current default startup workflow. Use [legacy checkout instructions](../legacy/cloudflare/README.md) when working on that release.

## Current progress

Updated **2026-10-06**: P0–P2 are complete locally; P3 accounts and permissions are implemented with local acceptance checks passed. Real Google sign-in and SMTP delivery still need configuration and live verification. **P4 — preferences, PostgreSQL bookmarks and ranking — is next.** Production migration and the new collector schedule have not been activated.

See the [current progress and next steps](12-implementation-plan.md#current-progress--2026-10-08) and [P3 activation requirements](16-p3-accounts.md).

## Start here

**Implementation progress:** [12 — Implementation plan](12-implementation-plan.md) tracks delivery. [13 — P0 baseline](13-p0-baseline.md) records the completed compatibility checks and pinned stack. [14 — P1 foundation](14-p1-foundation.md) records the runtime migration and map fix.

**Next-version design:** [11 — Target system design](11-target-system-design.md) records the selected Node.js, PostgreSQL and S3-compatible architecture, accounts/preferences, collection pipeline, AI retrieval and migration plan. P0–P3 are implemented locally; P4–P8 remain planned. Documents 01–10 below describe the legacy Cloudflare application.

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
| [12 — Implementation plan](12-implementation-plan.md) | Current progress, next steps, phase checklists and cutover gates. |
| [13 — P0 baseline](13-p0-baseline.md) | Baseline compatibility evidence. |
| [14 — P1 foundation](14-p1-foundation.md) | Node runtime migration and verification. |
| [15 — P2 storage](15-p2-storage.md) | PostgreSQL/S3 implementation and migration rehearsal. |
| [16 — P3 accounts](16-p3-accounts.md) | Accounts, grants, provider setup and acceptance evidence. |
| [17 — P5 collection jobs](17-p5-collection.md) | Job queue, schedules, run history, failure handling and evidence. |

## Fastest path to running it

```bash
npm ci               # install (npm run install:ci is an alias)
npm run setup        # create .env.local
npm run services:up  # PostgreSQL and private S3
npm run db:migrate
npm run db:seed
npm run dev          # Next.js dev server on http://127.0.0.1:5173
```

Fresh checkouts use invitation-only accounts; see P3 owner bootstrap instructions. The owner's explicit local mode disables the prompt on loopback. See the root README for current commands, Docker services and the P3 account setup.

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
