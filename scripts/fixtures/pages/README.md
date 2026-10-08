# Saved source pages

Trimmed copies of the public listing pages, saved 2026-10-08 for parser regression tests
([`source-pages.test.mjs`](../../tests/source-pages.test.mjs)). Each page was reduced to the
listing markup the parsers read: head, scripts, styles, SVG, navigation, header, footer and
unused attributes removed. Travel Manitoba keeps only its event cards and page links. Every
trimmed page was checked to parse exactly like the full page.

| File | Page |
| --- | --- |
| `forks-2026-10.html`, `-11`, `-12` | theforks.com/events/calendar-of-events (and `/list/2026/11`, `/12`) |
| `forks-attractions.html` | theforks.com/attractions |
| `park-page-1.html` … `-3` | assiniboinepark.ca/events (`?page=2`, `?page=3`) |
| `manitoba-page-1.html`, `-2` | travelmanitoba.com/events/ (`?page=2`) |
| `free-swim.html`, `indoor-pools.html` | winnipeg.ca free-swim schedule and indoor-pool directory |

Content belongs to the source sites; it is kept only to test parsing. To refresh after a site
change, save the page again, trim it the same way, confirm the parser output is what the site
shows, and update the expected values in the test.
