# Tourism Winnipeg

Issue #28. Manual source `tourism-winnipeg` covers the upcoming calendar and annual festivals directory. `npm run collect:tourism` is read-only; `npm run collect:tourism -- --enqueue` explicitly queues an import into the configured database. The source has no enabled schedule. This branch builds on the common public-calendar/private-photo helpers in PR #31.

## Collection strategy

The calendar's published form accepts a start and end date. The collector POSTs the full current and next Winnipeg months, verifies all six returned date controls, then follows the site's opaque filtered pagination URLs. It rejects changed filters, sections, missing structured dates and malformed pages. Maximums are 40 calendar pages and five annual-directory pages. Every visible calendar card must have matching Event JSON-LD; all explicit date entries are collected, including recurring dates beyond a card's broad overall span. Entries wholly outside the window are excluded; original bounds are retained for date ranges that overlap it.

One detail request per shared event supplies descriptions, published time labels, explicit free admission and event images. Unknown prices remain unknown. Date-only source data stays date-only; literal hours such as “5-9pm and later” do not become a fabricated precise closing time. Title and numeric source IDs preserve independent shows. Numeric identities and linked dates remain stable if the source changes its URL slug.

Exhibitions with short, explicit visiting-date blocks become one card per listed day, retaining gaps such as Monday/Tuesday closures. A long exhibition range without verified visiting days stays hidden for review rather than guessing daily availability. Festival date ranges remain festival ranges, not invented daily occurrences. Public contact blocks and unrelated nearby listings are excluded from descriptions/photos.

Both annual-directory pages and their detail pages are read. An explicit year is required for dates; month-only, season-only and TBD entries remain hidden Activities for review. Impossible dates and ambiguous multiple ranges are not published. Confirmed past/outside-window editions are skipped. Annual entries link to a calendar event only through an explicit cross-link or a unique identical title with the same confirmed edition start/end range. The original directory URL is retained. On the verified run, Manito Ahbee and Manitoba Hydro Santa Parade matched their calendar editions. Missing entries never imply cancellation.

At most three event-specific photos pass through common private storage. Published calendar thumbnails are fallback candidates when detail images fail; no image URL is invented. Existing verified images are reused, and failed enrichment retains previous media. An image failure makes the run partial while a completely verified calendar can still update its own dates. Partial calendars preserve prior dates and owner overrides.

Requests are serial, with one-second start spacing, 30-second individual timeouts, an 800-request/19-minute bound, and a 25-minute worker lease (including bounded AI comparison time). HTML caps at 2 MB and images at 8 MB. Redirects and non-allowlisted source URLs are rejected.

## October–November 2026 verification

The October 26 QA pass read all **29 filtered calendar pages (255 cards)** plus **two annual pages (21 entries)** and 276 detail pages. After filtering past editions and combining two annual/calendar matches, the batch contains **259 shared records and 604 linked dates**, with private photos on **254 records**. Five records remain hidden for review: two broad exhibitions and three annual entries without confirmed dates.

The calendar coverage is complete. Photo enrichment remains partial for four events because both their published detail and thumbnail URLs return HTTP 404: Jourdain Fisher, Paul Myrehaug, Gate Night with the Pattycakes, and Laura Ramoso. One additional record has no usable published image. No stock image or guessed URL replaces these gaps.

The separate `winnigo_p2_qa` database and private test storage were used throughout. Repeat imports add no duplicate parents; synthetic tests verify owner corrections/hidden states and incomplete-read history. A real Chrome check on dev/built QA apps verified 25 forthcoming Staycation visiting-day cards, loaded private card/detail images, a CSS grid and zero JavaScript errors. Full unit/typecheck/build and temporary PostgreSQL/queue checks pass; both origins deliver valid styles and browser modules.

## Cross-source review still needed

The QA overlap audit found 28 distinct source-pair/title/day candidates across Manitoba Music, Travel Manitoba, Manitoba Museum and FortWhyte. These are candidates, not confirmed equivalent performances: for example, Candlelight has separate evening showtimes while Tourism Winnipeg supplies a date-level entry. No cross-source records are automatically merged on title/day alone. The annual/calendar duplicates within Tourism Winnipeg are handled, but reliable cross-source matching and more precise showtime splitting remain open review work for #28/#29. Collection schedules remain disabled while this is reviewed. Terms/access review remains deferred as requested.

## October 27 date correction and complete calendar audit

Tourism Winnipeg clips an ongoing range's beginning to the calendar filter (or today's date on
its detail page). That is an observed collection boundary, not necessarily the event's opening.
Égoportraits was consequently shown as starting October 1. Its linked [CCFM event page](https://ccfm.mb.ca/en/events/egoportraits/)
confirms the actual run **August 27–November 20, 2026**.

Exhibition detection now reads the complete bilingual description, including explicit gallery
collections, before shortening the stored summary. It ignores the venue name “Exhibition Park”.
Original run dates are retained separately from visiting dates. A linked CCFM event can verify
run dates and an explicit all-day period; its host/path, title and labeled date fields are checked.
Narrative run dates are accepted only when they end on the source's published closing date;
any missing year comes from that published date. Conflicting/invalid dates remain unconfirmed.
Earlier verified organizer bounds survive a failed refresh when the source closing date agrees.

An explicit continuous all-day exhibition produces bounded date-only cards, without invented
midnight timestamps or precise opening hours. Égoportraits has **51 cards, October 1–November 20**,
and its actual August opening remains in `runDates`. The detail dialog displays the full run
separately from the selected visiting date. “All day” does not assert 24-hour access; exact gallery
hours remain unconfirmed. Other exhibition ranges still require verified visiting blocks.

The two Égoportraits directory entries are combined only after matching a verified specific
organizer event against its homepage alias, original bounds, venue and title. The specific event
keeps its stable ID and both source links. The alias is retained as hidden history. This does not
introduce title-only or cross-source deduplication.

A fresh read checked **all 29 calendar pages / 255 calendar entries**, both annual pages and
276 Tourism Winnipeg detail pages, plus the linked organizer event. A separate comparison of
every calendar entry's listed days against the resulting occurrences found **zero date-set
mismatches**, including closure gaps. The changes also correct visiting-day projection for
**Omalluq: Stories from my Life** and **Witchy Wonderland – A (not-so) Fright Fest**. The final
batch has **258 shared records and 684 dates** after removing the duplicate exhibition entry.
The QA date refresh reused existing private photos, retained 253 photographed records and
verified that owner edits/visibility were preserved. It did not change the normal database or
collection schedules. Raw audit pages/results remain in the ignored local runtime directory.


## AI shadow onboarding — November 16, 2026

This epic integration ports the existing Tourism collector from PR #32 and its shared HTTP/media
helper from PR #31, without merging the Music collector or changing those PRs. The source stays
manual-only and uses the shared listing/occurrence and private-media repository.

To compare already-fetched detail pages, configure the existing provider/key/model/budget settings
and `WINNIGO_EXTRACTION_SOURCES=tourism-winnipeg=shadow` in the worker environment. Enqueue a
manual collection with `npm run collect:tourism -- --enqueue`; the CLI dry run remains parser-only.
`tourism-winnipeg=write` is rejected until date/time refinements are reviewed. Extraction defaults
to off. Tourism has no organization venue fallback: locations must come from event evidence.

Captured context contains focused event/profile content, only matching calendar records, and a
validated specific organizer page when the parser already fetched it. The calendar-document
helper is shared with Museum. Calendar evidence is capped at eight documents plus the primary
and organizer pages; at most 100 retained event pages are compared. No model step re-fetches
pages. Calendar/annual aliases removed by verified deduplication do not create duplicate model
comparisons. A configurable detail limit makes bounded QA samples explicitly partial.

Date and clock excerpts can come from separate documents. Every excerpt must match supplied text;
the app records a separate citation for each document. Unsupported excerpts still reject the
whole fact. This changes neither the model JSON schema nor the database model.

The bounded live QA sample read one filtered November–December calendar page, one annual directory
page and six calendar-event details. It saved **6 parser events / 81 sessions**, each with a private
photo; annual detail extraction and full-site coverage were not measured by this live sample.
The initial detail-only comparison highlighted time enrichment and clipped exhibition labels.
With matching calendar context and exact cross-document citations, the final saved-response model
pass produced **3 differing candidates / 3 withheld**, with zero provider failures:

- First Friday, Sustainability Tour and UnCommon Pours add time precision; Sustainability Tour
  also proposes a free admission amount that needs review.
- Second Saturdays is held because its quote reformats an ISO calendar date into wording absent
  from the supplied text. The evidence matcher intentionally does not accept that substitution.
- Staycation and Omalluq are held for inconsistent or missing usable schedule facts. The calendar
  includes visiting days before the detail page's November 18 label; that label must not become
  an invented original opening date. Parser visiting days remain intact.

The final model pass cost an estimated US$0.006061 at configured rates. A repeat from saved inputs
used **6/6 cache hits, zero provider calls/cost, 0 added / 6 unchanged**, preserving all 81 sessions
and verifying all six photo hashes. These are comparison outcomes, not a scored accuracy pilot.
Historical full-pilot figures were not rerun or replaced for this source/context change.

199 unit tests, typecheck/build, extraction/P2/P5 integration, dev/built asset checks and seeded
browser regression passed. Chrome confirmed a completed Tourism card grid with loaded private
photos; a verified exhibition also displayed its overall run separately from its selected day.
Raw pages, inputs, outputs and QA environment stay local and ignored. No production destination,
audience or schedule changed.

Before enabling writes, define how date-only sessions can gain verified times while preserving
occurrence IDs, owner edits and every published visiting day. Resolve the exhibition boundary and
remaining quote/schedule cases above, then rerun the source comparison. The shared write guard is
kept in place while these measured differences remain open.
