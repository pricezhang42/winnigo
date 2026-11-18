# Event extraction integration

`prepareExtractedCollection(result, context, options)` validates the extraction and prepares
at most one main event in Winnigo's existing listing and occurrence formats. The source adapter supplies
`source: { id, name }`, an `identifyEvent(url)` callback that approves URLs and resolves
canonical identity, and any existing listings from `repository.knownSourceListings(source.id)`.
The adapter can supply an established listing ID or external identity. The mapper reuses a known
matching listing and occurrence IDs.

- Map showtimes and recurring sessions to one parent listing and separate occurrences in the
  current and next Winnipeg calendar months. Record the year assumption when a date omits the year.
- Keep an exhibition's advertised run dates separate from its visit days. Expand known opening
  hours and apply dated exceptions. Hold unsupported cases such as multiple opening intervals in
  a day, ambiguous DST times and conflicting schedules for review.
- Keep unknown end times and prices unknown. Keep the derived evidence quotes, original schedule
  facts and photo candidates with the mapped listing for review. Hold the event when the parser
  records review reasons (an unsupported title or schedule entry, or a model-reported title,
  schedule or unclassified conflict).
- If a trusted photo policy is supplied, approve URLs before reading bytes and store up to three
  verified JPEG, PNG or WebP images through the existing private photo interface. The reader must
  enforce source scope on redirects and bound downloads. Images are not classified; a listing
  that already has stored photos keeps them, so a later run cannot replace a verified cover.

The mapper returns candidates and review reasons without writing listings. A batch with review
items or photo failures has partial status. An empty batch cannot establish source coverage.
Use the existing repository's partial import options (`complete: false`, `cancelMissing: false`)
when testing a reviewed batch. Run `npm run check:event-extraction` to exercise repeated partial imports,
historical occurrences, editor overrides and private media associations in a temporary schema.
Live collection still uses the existing source parsers.
