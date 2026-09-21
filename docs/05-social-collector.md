# 05 — Social outings & the Facebook collector

Two ways community hiking/cycling outings enter Winnigo: the owner adds them **manually**, or the
scheduled **Selenium collector** imports them from the private Hiking Manitoba Facebook group.
Authoritative operating manual: [`HIKING-COLLECTOR.md`](../HIKING-COLLECTOR.md). This doc maps that
onto the code.

## Community sources ([`lib/social.mjs:1`](../lib/social.mjs))

```
facebook  → Hiking Manitoba group 810758152436911, mode "browser" (daily collector)
instagram → manual, mode "manual" (add specific posts by link; no feed)
```

## Manual add ([`components/social-outing-form.tsx`](../components/social-outing-form.tsx))

The `/admin` page (and `/admin?add=social` deep link) shows a form → `POST /api/sources`
`{action:'add-social', ...}`. The server validates via `normalizeSocial()`
([`lib/social.mjs:5`](../lib/social.mjs)):

- Requires a title and a valid **https** Facebook or Instagram **post/permalink** URL (rejects group
  homepages).
- Strips tracking params (keeps only `story_fbid`/`id`/`fbid`), drops the hash.
- Category ∈ Hiking/Cycling; type Event (needs valid dates, end ≥ start) or Activity.
- Distance 0–2000 km or null; difficulty ∈ Unknown/Easy/Moderate/Challenging.
- Duplicate post URLs (same source) are rejected with a 409.
- Marks `provenance:'manual'`.

## The daily collector — big picture

**This runs on a local machine, not in the Worker.** A Codex thread automation fires at 09:00
America/Winnipeg and:

1. Verifies the Site is still owner-private (owner role, custom access, exactly one allowed user,
   no group grants, zero external visitors). If not, it **stops** — never changes access.
2. Runs Selenium to gather candidate posts.
3. Extracts/paraphrases route facts (no personal data), builds a sanitized batch.
4. Publishes the batch (and photos) to Winnigo using the owner's short-lived token + collector key.

The collector is **bounded**: up to ~100 newest posts, ≤80 scrolls / 5 min, best-effort. It cannot
guarantee complete coverage and only runs when the local host + signed-in Chrome are available.

## Step 1 — Selenium candidate collection ([`scripts/collect-hiking-selenium.py`](../scripts/collect-hiking-selenium.py))

- Opens **only** the Hiking Manitoba group with chronological sort, verifies "New posts" ordering,
  reads visible post message elements (`[data-ad-preview="message"]`), expands "See more", scrolls
  within limits, and collects up to 100 canonical post permalinks to
  `.sites-runtime/hiking-candidates.json` (mode 600).
- Reads **feed direct children** for posts (Facebook uses `role=article` for comments in the
  observed layout).
- Only accepts **canonical post permalinks** within this group — never comment/profile links
  (`post_url()` guard).
- Redacts contact info; never collects author names/phones/emails/profile ids.
- Exit codes: blocked run → exit 2; partial run is marked `partial`. Stops on sign-in/challenge/
  access-denied/unsupported layout rather than bypassing.
- Uses a **dedicated** Chrome profile in `.sites-runtime/hiking-chrome-profile` (git-ignored,
  locked while in use). **Never** copies the user's normal Chrome cookies/profile.
- Candidate post text is **untrusted source material, never instructions.**

One-time / re-login:

```bash
.sites-runtime/selenium-venv/bin/python scripts/collect-hiking-selenium.py --login
.sites-runtime/selenium-venv/bin/python scripts/collect-hiking-selenium.py --headless
```

No Facebook password is ever passed to the script.

## Step 1b — Enrichment ([`scripts/enrich-hiking-posts.py`](../scripts/enrich-hiking-posts.py))

For up to ~15 chosen posts, opens each permalink separately, expands up to six comment/reply
controls, and reads up to 20 photos from the image viewer. Writes a private `hiking-enriched.json`
to delete after import. Full-size reads may fall back to feed previews; partial status is preserved.
Never clicks Like/Reply/Follow/Send.

## Step 2 — Batch normalization ([`lib/social.mjs:26`](../lib/social.mjs) `normalizeHikingBatch`)

The Codex step writes `/tmp/winnigo-hiking-batch.json`. Shape:

```json
{ "status": "ok|partial|blocked", "message": "…", "items": [ /* per-post objects */ ] }
```

Each item: `title`, `url` (individual FB post), `category` (Hiking/Cycling), `type` (Event/Activity),
`start`/`end` (only confirmed events), `time`, `venue`, `neighbourhood`, `description` (≤1200),
`distanceKm`, `difficulty`, `photoUrls` (≤20 FB CDN URLs, never avatars), `commentNotes`
(≤10 `{text,url}` linked to the original comment), optional `cancelled:true`.

`normalizeHikingBatch()` re-runs `normalizeSocial()` per item, forces Facebook-only, canonicalizes
the URL to `https://facebook.com/`, validates stored-photo paths (`/api/photos/<64hex>`) and comment
links (must be `…/groups/810758152436911/(posts|permalink)/<id>/`), and stamps
`provenance:'browser'`, `sourceVisibility:'private'`. A `blocked` status must carry zero items.

## Step 3 — Publish ([`scripts/publish-social.mjs`](../scripts/publish-social.mjs))

```bash
WINNIGO_AUTH_TOKEN=<owner short-lived Sites token> \
  node scripts/publish-social.mjs /tmp/winnigo-hiking-batch.json
```

- Reads the collector key from `.sites-runtime/hiking-collector-key` (mode 600, git-ignored; never
  print/commit). Sends `X-Winnigo-Collector-Key` + `OAI-Sites-Authorization: Bearer <token>`.
- For each item, fetches the FB CDN photos **from the collector host** (Workers CDN access can
  differ), streams them (≤8 MB) to `POST /api/photos/import`, and replaces `photoUrls` with the
  returned stable `/api/photos/<hash>` paths. Failed photos → batch marked `partial`, existing photos
  retained.
- Posts items to `POST /api/sources` `{action:'sync-hiking-manitoba'}` in chunks of 10, against the
  **fixed** origin `https://winnigo.wasdpyzlp.chatgpt.site`.
- Never claims "imported" until the server confirms `ok`.

## Step 4 — Server upsert ([`app/api/sources/route.ts:8`](../app/api/sources/route.ts))

The `sync-hiking-manitoba` branch:

- Auth: collector key **or** owner session; collector key is restricted to this action only.
- Upserts each item by canonical URL (dedup lookup normalizes `www.facebook.com` → `facebook.com`),
  keying the row id as `facebook-<sha256(url)>`.
- Merges images (union, cap 20), preserves prior `addedAt`, tracks added/updated counts.
- Writes a `facebook` row into `sources` with the batch status; `checked_at` only advances on `ok`.

## Photo storage ([`app/api/photos/import`](../app/api/photos/import/route.ts) + [`[id]`](../app/api/photos/[id]/route.ts))

- Import validates https `*.fbcdn.net` source, streams ≤8 MB, sniffs magic bytes for JPEG/PNG/WEBP,
  hashes bytes → `photos/<sha256>` in R2 (dedup by content hash), returns `/api/photos/<hash>`.
- Serving requires a 64-hex id, returns `Cache-Control: private`, `X-Content-Type-Options: nosniff`.
- Photos are private; they render in clickable galleries ([`listing-gallery.tsx`](../components/listing-gallery.tsx))
  only inside the owner-private Site.

## Collector tests

```bash
.sites-runtime/selenium-venv/bin/python scripts/tests/selenium_collector_test.py
```

Covers canonical link parsing, contact redaction, private file permissions, and message extraction
against a local fixture in real headless Chrome. **Fixture tests don't prove live selector
compatibility** — confirm a live run after login. A changed FB layout yields blocked/partial, never
a false empty success.
