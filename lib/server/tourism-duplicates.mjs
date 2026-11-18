const words = (s) =>
  String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const nextDay = (d) => new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
const days = (item) =>
  (item.occurrences || []).reduce(
    (n, o) => n + (Date.parse(o.end) - Date.parse(o.start)) / 86400000 + 1,
    0,
  );
function covered(row, rows) {
  if (row.status !== 'active') return false;
  for (let d = row.start; d <= row.end; d = nextDay(d))
    if (
      !rows.some(
        (o) =>
          o.status === 'active' &&
          o.start <= d &&
          o.end >= d &&
          ((!row.startAt && !o.startAt) || (row.startAt === o.startAt && row.endAt === o.endAt)),
      )
    )
      return false;
  return true;
}

// Keep source IDs, owner edits and unique visiting days. Only suppress overlapping
// cards when title, venue and substantial description all establish the same show.
// Conflicting run bounds cannot justify deleting either page's unique dates.
export function combineTourismDuplicates(result) {
  const suppressed = new Set();
  let visits = 0;
  for (const kept of [...result.items].sort(
    (a, b) => days(b) - days(a) || a.id.localeCompare(b.id),
  )) {
    if (suppressed.has(kept.id) || !kept.venue || !kept.occurrences?.length) continue;
    for (const copy of result.items) {
      if (
        copy.id === kept.id ||
        suppressed.has(copy.id) ||
        !copy.occurrences?.length ||
        words(copy.title) !== words(kept.title) ||
        words(copy.venue) !== words(kept.venue)
      )
        continue;
      const a = words(kept.description),
        b = words(copy.description);
      if (Math.min(a.length, b.length) < 180 || a.slice(0, 180) !== b.slice(0, 180)) continue;
      let overlaps = false;
      copy.occurrences = copy.occurrences.flatMap((row) => {
        if (row.status !== 'active') return [row];
        const unique = [];
        for (let d = row.start; d <= row.end; d = nextDay(d))
          if (!covered({ ...row, start: d, end: d }, kept.occurrences)) unique.push(d);
        if (unique.length === (Date.parse(row.end) - Date.parse(row.start)) / 86400000 + 1)
          return [row];
        overlaps = true;
        visits++;
        // Preserve the original range and ID as history. Unique days receive stable
        // child IDs and inherit its existing editorial state in the shared repository.
        return [
          { ...row, status: 'superseded', duplicateOf: kept.id },
          ...unique.map((d) => ({
            ...row,
            id: row.id + '-visit-' + d,
            start: d,
            end: d,
            derivedFrom: row.id,
            status: 'active',
          })),
        ];
      });
      if (!overlaps) continue;
      kept.sourceLinks = [...new Set([...(kept.sourceLinks || []), copy.url])];
      copy.sourceLinks = [...new Set([...(copy.sourceLinks || []), kept.url])];
      copy.sourceConflicts = [
        'Duplicate source pages disagree or may differ on overall run bounds; unique calendar dates are retained.',
      ];
      if (!copy.occurrences.some((o) => o.status === 'active')) {
        copy.status = 'hidden';
        copy.reviewReason = 'Duplicate calendar visits are shown under the linked source entry';
      }
      suppressed.add(copy.id);
    }
  }
  result.calendarDuplicates = suppressed.size;
  result.duplicateVisits = visits;
}
