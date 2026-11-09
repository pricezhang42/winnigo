# Prepare public event pages for extraction

Issue #36, step 2 of Epic #33. This module converts already-fetched public event HTML into
the [version 1 extraction context](20-event-extraction-contract.md). It uses Cheerio and does
not fetch links, call a model, infer event facts, or write data.

```js
import { prepareExtractionContext } from './lib/server/event-page-preparation.mjs';

const pageUrl = 'https://events.example.test/calendar/';
const context = prepareExtractionContext({
  source: 'example-calendar',
  pageUrl,
  checkedAt: '2026-11-08T18:00:00Z',
  pages: [{
    url: pageUrl,
    html: '<main><article><h2>Concert</h2><time datetime="2026-11-20">Nov 20</time><p>8 PM</p></article></main>',
    selector: 'article',
  }],
});
```

`prepareExtractionDocument` also prepares one `{ url, html, selector?, exclude? }` input
on its own. The context helper runs the shared validator and computes this and next month
from `checkedAt` in Winnipeg. Pass each separately fetched supporting page as its own entry
in `pages`; do not combine organizer wording with the aggregator's source document.

## What survives preparation

- Explicit `selector` picks one or more event sections. Without it, the preparer tries the
  first main region, `#content`/`#maincontent`, then the body. `exclude` can remove site-specific
  clutter inside the selected region. These selectors are application configuration, not scraped instructions.
- The text keeps headings, article and list boundaries, relevant sidebars, dates and hours.
  A `<time>` element keeps its display text and separately labeled `datetime` attribute. A midnight
  attribute on a calendar card is **not** interpreted as a midnight performance.
- Tables keep their rows, captions, cells, column/row spans and header associations as small HTML
  snippets. Styling and executable attributes are omitted. Line breaks inside cells are retained.
- Event and EventSeries JSON-LD inside selected content is preserved with event-relevant fields.
  A record outside that content must identify the page URL. Unrelated graph entities are skipped;
  references to separate graph objects are not resolved. Visible text and structured data both remain
  available if they disagree.
- Link labels stay with their URLs in the text. Links and image candidates also appear once in
  `documents[].urls`. Relative URLs are resolved against the fetched page URL. Only HTTPS URLs
  without credentials are added as URL candidates; supplying a URL is not permission to fetch it. Image URLs come
  from image `src`/lazy attributes and Event JSON-LD; CSS backgrounds are not interpreted.
- Navigation, site headers/footers, forms, scripts other than event data, hidden markup and recognized
  related/sponsor sections are dropped. Evidence should quote the prepared text, whose whitespace
  is normalized and which may include formatting labels. It is not a byte-for-byte HTML copy.

This is a bounded HTML preparation step, not a browser renderer. Use the source's existing fetch
and access checks first, and choose a narrower selector when the generic main region includes
unrelated cards or overlays. The preparer does not expand dates, resolve contradictions, classify
image fallbacks, or mark a collection complete. Missing sections and oversized inputs fail visibly.
The raw HTML cap is 2 MB per page; prepared documents and contexts use the shared contract limits.
For a larger calendar, prepare smaller groups of complete event cards in separate requests rather
than cutting text off mid-event. Source content remains untrusted data.

## Verification

Synthetic tests cover calendar attributes versus showtimes, selected event boundaries, schedule
tables and closures, JSON-LD scope, link provenance, separate source documents, and size limits.
The saved QA replay checked Bleeker's Manitoba Music card and the Tourism Winnipeg Égoportraits
listing with its separately captured organizer page. The complete Manitoba Music calendar page
also prepared successfully with 40 selected cards. Local replay artifacts are kept under the
ignored `.winnigo/extraction-preparation-evidence` directory.
