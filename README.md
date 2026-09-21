# Winnigo

Private Winnipeg and Manitoba discovery app: events, places, official trails, community hiking/cycling posts, and free swims.

**No Codex, ChatGPT account, MCP tools, or installed AI skills are needed for the standalone workflow.** Any agent or person with a terminal can use the commands below. React/TypeScript runs on Vinext/Vite, with Cloudflare Workers, D1 and R2. Local development emulates Cloudflare; it needs no Cloudflare account. Remote deployment needs your own Cloudflare account.

## Quick start

Requires Node.js 22.13+ and npm. From the repository root:

```sh
npm ci
npm run setup
npm run dev
```

Open http://127.0.0.1:5173. The browser asks for the owner username/password generated in the ignored `.dev.vars` file. Read that file locally; do not paste its values into commits, logs, or shared agent conversations. Setup preserves existing credentials and applies local database migrations. Listings seed themselves on first access. Photos collected on the original site are not bundled with the repository.

All routes, including photo reads and static assets in production, require owner authentication. The collector secret only authorizes the import endpoints and cannot read the private collection or edit arbitrary listings. Basic authentication must use HTTPS outside loopback. Missing credentials fail closed. Never set `WINNIGO_AUTH_MODE=sites` on a standalone host: that compatibility mode relies on the original hosting platform's access gate.

## Commands

| Command | Purpose |
|---|---|
| `npm run setup` | Generate local credentials if absent and apply migrations |
| `npm run dev` | Development server, loopback port 5173 |
| `npm test` | Data parsing, authentication, and publishing configuration tests |
| `npm run typecheck` | TypeScript validation |
| `npm run check:assets` | Verify a running dev server serves CSS and browser modules correctly |
| `npm run build` | Build standalone Worker and browser assets |
| `npm start` | Run the built Worker locally (Wrangler prints its port) |
| `npm run db:migrate` | Apply pending local migrations |
| `npm run db:generate` | Generate migrations after editing schema |
| `npm run deploy` | Build and deploy to your configured Cloudflare account |
| `npm run publish:hiking -- /path/batch.json` | Publish a reviewed, sanitized batch |

`npm run dev -- --port 5174` selects a different port. Set `WINNIGO_POLLING=1` if filesystem notifications are unavailable. Local state is under `.wrangler/`; it is not production data.

If the page appears unstyled, restart `npm run dev` after updating the checkout and run `npm run check:assets`. Development serves CSS and JavaScript through Vite, while the Worker protects app/API requests. Production retains the private gate for all assets. To check a built preview on another port, set `WINNIGO_CHECK_ORIGIN` to its loopback URL when running the asset check.

## Deploy with standard Cloudflare tools

1. Run `npx wrangler login` (or use a scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in CI).
2. Run `npx wrangler d1 create winnigo` and `npx wrangler r2 bucket create winnigo-photos`.
3. Put the returned database ID and your bucket name in `wrangler.json`. Its checked-in database ID is a local placeholder, not a production resource.
4. Apply schema: `npx wrangler d1 migrations apply DB --remote --config wrangler.json`.
5. Configure each secret with `npx wrangler secret put NAME --config wrangler.json`: `WINNIGO_ADMIN_USER`, `WINNIGO_ADMIN_PASSWORD`, `WINNIGO_COLLECTOR_KEY`. Use strong distinct random passwords/keys. `.dev.vars` is local-only and is not deployed.
6. Run `npm run deploy`. Verify unauthenticated requests return 401 and owner sign-in works before importing private community content.

Deployments use `assets.run_worker_first` so static assets cannot bypass the private access gate. Protect deployment credentials as owner credentials. The existing Sites database and photos are separate: creating a new deployment does not migrate them. Do not delete the original hosted site or its resources.

## Collectors and scheduling

See [HIKING-COLLECTOR.md](HIKING-COLLECTOR.md) for Selenium setup, the agent-independent review contract, publishing and scheduler examples. Public source refreshes currently run on visits every six hours; manual refresh is in `/admin`. Official trail import: `python3 scripts/import-official-trails.py` (read its command options first).

## Existing Sites compatibility

The original private site remains at https://winnigo.wasdpyzlp.chatgpt.site/. It has not been moved or made public. `npm run build:sites` retains its packaging and trusted platform authentication adapter; `.openai/hosting.json` is used only by this optional path. Existing Sites publishing still requires that platform's tools and account. Use the standalone deployment above when those tools are unavailable.

Old starter environment/install scripts and `app/chatgpt-auth.ts` remain for compatibility, but the default setup, dev, build, admin sign-in and collector upload no longer call them. A new agent should start with [AGENTS.md](AGENTS.md).
