# Tourism Winnipeg

Issue #28. Manual source `tourism-winnipeg` covers the upcoming calendar and annual festivals directory. `npm run collect:tourism` is read-only; `npm run collect:tourism -- --enqueue` explicitly queues an import into the configured database. The source has no enabled schedule. This branch builds on the common public-calendar/private-photo helpers in PR #31.

## Collection strategy

The calendar's published form accepts a start and end date. The collector POSTs the full current and next Winnipeg months, verifies all six returned date controls, then follows the site's opaque filtered pagination URLs. It rejects changed filters, sections, missing structured dates and malformed pages. Maximums are 40 calendar pages and five annual-directory pages. Every visible calendar card must have matching Event JSON-LD; all explicit date entries are collected, including recurring dates beyond a card's broad overall span. Entries wholly outside the window are excluded; original bounds are retained for date ranges that overlap it.

One detail request per shared event supplies descriptions, published time labels, explicit free admission and event images. Unknown prices remain unknown. Date-only source data stays date-only; literal hours such as “5-9pm and later” do not become a fabricated precise closing time. Title and numeric source IDs preserve independent shows. Numeric identities and linked dates remain stable if the source changes its URL slug.

Exhibitions with short, explicit visiting-date blocks become one card per listed day, retaining gaps such as Monday/Tuesday closures. A long exhibition range without verified visiting days stays hidden for review rather than guessing daily availability. Festival date ranges remain festival ranges, not invented daily occurrences. Public contact blocks and unrelated nearby listings are excluded from descriptions/photos.

Both annual-directory pages and their detail pages are read. An explicit year is required for dates; month-only, season-only and TBD entries remain hidden Activities for review. Impossible dates and ambiguous multiple ranges are not published. Confirmed past/outside-window editions are skipped. Annual entries link to a calendar event only through an explicit cross-link or a unique identical title with the same confirmed edition start/end range. The original directory URL is retained. On the verified run, Manito Ahbee and Manitoba Hydro Santa Parade matched their calendar editions. Missing entries never imply cancellation.

At most three event-specific photos pass through common private storage. Published calendar thumbnails are fallback candidates when detail images fail; no image URL is invented. Existing verified images are reused, and failed enrichment retains previous media. An image failure makes the run partial while a completely verified calendar can still update its own dates. Partial calendars preserve prior dates and owner overrides.

Requests are serial, with one-second start spacing, 30-second individual timeouts, an 800-request/19-minute bound, and a 20-minute worker lease. HTML caps at 2 MB and images at 8 MB. Redirects and non-allowlisted source URLs are rejected.

## October–November 2026 verification

The October 26 QA pass read all **29 filtered calendar pages (255 cards)** plus **two annual pages (21 entries)** and 276 detail pages. After filtering past editions and combining two annual/calendar matches, the batch contains **259 shared records and 604 linked dates**, with private photos on **254 records**. Five records remain hidden for review: two broad exhibitions and three annual entries without confirmed dates.

The calendar coverage is complete. Photo enrichment remains partial for four events because both their published detail and thumbnail URLs return HTTP 404: Jourdain Fisher, Paul Myrehaug, Gate Night with the Pattycakes, and Laura Ramoso. One additional record has no usable published image. No stock image or guessed URL replaces these gaps.

The separate `winnigo_p2_qa` database and private test storage were used throughout. Repeat imports add no duplicate parents; synthetic tests verify owner corrections/hidden states and incomplete-read history. A real Chrome check on dev/built QA apps verified 25 forthcoming Staycation visiting-day cards, loaded private card/detail images, a CSS grid and zero JavaScript errors. Full unit/typecheck/build and temporary PostgreSQL/queue checks pass; both origins deliver valid styles and browser modules.

## Cross-source review still needed

The QA overlap audit found 28 distinct source-pair/title/day candidates across Manitoba Music, Travel Manitoba, Manitoba Museum and FortWhyte. These are candidates, not confirmed equivalent performances: for example, Candlelight has separate evening showtimes while Tourism Winnipeg supplies a date-level entry. No cross-source records are automatically merged on title/day alone. The annual/calendar duplicates within Tourism Winnipeg are handled, but reliable cross-source matching and more precise showtime splitting remain open review work for #28/#29. Collection schedules remain disabled while this is reviewed. Terms/access review remains deferred as requested.
