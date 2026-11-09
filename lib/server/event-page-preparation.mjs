import { load } from 'cheerio';
import { collectionWindow, DEFAULT_TIME_ZONE } from '../event-schedule.mjs';
import {
  EXTRACTION_LIMITS,
  EXTRACTION_VERSION,
  parseExtractionContext,
} from '../contracts/event-extraction.mjs';

const MAX_HTML_BYTES = 2_000_000;
const MAX_DEPTH = 80;
const LD = 'script[type="application/ld+json"]';
const REMOVE = [
  'nav',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  'body > header',
  'body > footer',
  'form',
  'style',
  'template',
  'noscript',
  'svg',
  'iframe',
  '[hidden]',
  '[aria-hidden="true"]',
  '.site-header',
  '.site-footer',
  '.related-events',
  '.tribe-events-related-events',
  '.sponsors',
  '.event-sponsors',
].join(', ');
const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'header',
  'main',
  'ol',
  'p',
  'section',
  'ul',
]);
const TABLE = new Set(['table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);
const CELL = new Set(['caption', 'th', 'td']);
const EVENT_FIELDS = new Set([
  '@type',
  '@id',
  'name',
  'description',
  'url',
  'startDate',
  'endDate',
  'startTime',
  'endTime',
  'previousStartDate',
  'eventStatus',
  'eventAttendanceMode',
  'eventSchedule',
  'scheduleTimezone',
  'repeatFrequency',
  'repeatCount',
  'duration',
  'byDay',
  'byMonth',
  'byMonthDay',
  'byMonthWeek',
  'exceptDate',
  'dayOfWeek',
  'validFrom',
  'validThrough',
  'opens',
  'closes',
  'openingHours',
  'openingHoursSpecification',
  'specialOpeningHoursSpecification',
  'location',
  'address',
  'streetAddress',
  'addressLocality',
  'addressRegion',
  'postalCode',
  'addressCountry',
  'offers',
  'price',
  'priceCurrency',
  'availability',
  'isAccessibleForFree',
  'organizer',
  'performer',
  'image',
  'contentUrl',
  'caption',
  'superEvent',
  'subEvent',
]);
const GRAPH_FIELDS = ['@graph', 'mainEntity', 'itemListElement', 'item'];
const URL_FIELDS = new Set(['url', 'image', 'contentUrl']);

const compact = (s) => s.replace(/\s+/g, ' ').trim();
const cleanLines = (s) =>
  s
    .split('\n')
    .map(compact)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const escapeHtml = (s) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function httpsUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('#')) return null;
  let u;
  try {
    u = new URL(value, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.href.length > 2048) throw Error('Prepared event URL exceeds contract limits');
  return u.href;
}
function depthCheck(depth) {
  if (depth > MAX_DEPTH) throw Error('Event page nesting limit exceeded');
}

/** Render visible content as text, preserving table structure and exact URL associations. */
function renderDocument(roots, registerUrl, separator = '\n\n') {
  function children(node, depth) {
    let result = '',
      previous;
    for (const child of node.children || []) {
      const rendered = render(child, depth + 1);
      if (!rendered) continue;
      // Separate adjacent markup fields (such as venue address and region) without
      // inserting spaces into inline text such as "October <b>28</b>, 2026".
      if (
        previous?.name &&
        child.name &&
        /[\p{L}\p{N})\]]$/u.test(result) &&
        /^[\p{L}\p{N}]/u.test(rendered)
      )
        result += ' ';
      result += rendered;
      previous = child;
    }
    return result;
  }
  function table(node, depth) {
    depthCheck(depth);
    const { name, attribs = {} } = node;
    const attrs = ['rowspan', 'colspan', 'scope', 'headers', 'id']
      .filter((k) => attribs[k] && attribs[k].length <= 100)
      .map((k) => ` ${k}="${escapeHtml(attribs[k])}"`)
      .join('');
    const inner = CELL.has(name)
      ? escapeHtml(cleanLines(children(node, depth))).replaceAll('\n', '<br>')
      : (node.children || [])
          .filter((n) => TABLE.has(n.name))
          .map((n) => table(n, depth + 1))
          .join('');
    return `<${name}${attrs}>${inner}</${name}>`;
  }
  function render(node, depth) {
    depthCheck(depth);
    if (node.type === 'text') return node.data.replace(/\s+/g, ' ');
    if (node.type === 'root') return children(node, depth);
    if (!node.name || node.name === 'script') return '';
    const { name, attribs = {} } = node;
    if (name === 'br' || name === 'hr') return '\n';
    if (name === 'table') return `\n${table(node, depth)}\n`;
    if (name === 'img') {
      const url =
        registerUrl(attribs['data-src']) ||
        registerUrl(attribs['data-lazy-src']) ||
        registerUrl(attribs.src);
      return url
        ? `\nImage${attribs.alt?.trim() ? ` (${compact(attribs.alt)})` : ''}: ${url}\n`
        : '';
    }
    const inner = children(node, depth);
    if (name === 'a') {
      const label =
        inner.trim() || compact(attribs['data-alt-title'] || attribs['aria-label'] || '');
      const url = registerUrl(attribs.href);
      return url && label !== url ? `${label}${label ? ' ' : ''}(${url})` : label;
    }
    if (name === 'time' && attribs.datetime) {
      return `\n${inner.trim()} [HTML datetime: ${compact(attribs.datetime)}]\n`;
    }
    if (/^h[1-6]$/.test(name) && inner.trim())
      return `\n${'#'.repeat(Number(name[1]))} ${inner.trim()}\n`;
    if (name === 'li') return `\n- ${inner.trim()}\n`;
    if (name === 'article') return `\n\n[Article]\n${inner}\n[/Article]\n\n`;
    if (name === 'section') return `\n\n${inner}\n\n`;
    return BLOCK.has(name) ? `\n${inner}\n` : inner;
  }
  return roots.map((node) => render(node, 0)).join(separator);
}

function eventEntities(value) {
  const events = [],
    pending = [value];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) pending.push(node[i]);
      continue;
    }
    const types = [node['@type']].flat();
    if (
      types.some(
        (t) =>
          typeof t === 'string' && /(?:^|[/#:])(?:[A-Z][a-zA-Z]*Event|Event|EventSeries)$/.test(t),
      )
    )
      events.push(node);
    else for (const key of GRAPH_FIELDS) if (node[key]) pending.push(node[key]);
  }
  return events;
}

function projectEventData(node, registerUrl, key = '', depth = 0) {
  depthCheck(depth);
  if (Array.isArray(node))
    return node
      .map((n) => projectEventData(n, registerUrl, key, depth + 1))
      .filter((v) => v !== undefined);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => EVENT_FIELDS.has(k))
        .map(([k, v]) => [k, projectEventData(v, registerUrl, k, depth + 1)])
        .filter(([, v]) => v !== undefined),
    );
  }
  if (typeof node !== 'string') return node;
  if (URL_FIELDS.has(key)) return registerUrl(node) || undefined;
  if (key === 'description' && /<[a-z][\s\S]*>/i.test(node)) {
    const $ = load(node, {}, false);
    $('script, style, template, iframe').remove();
    return cleanLines(renderDocument($.root().toArray(), registerUrl));
  }
  return compact(node);
}

/** Prepare one already-fetched public page. Selectors are caller configuration, not page data. */
export function prepareExtractionDocument({ url, html, selector, exclude }) {
  const pageUrl = httpsUrl(url);
  if (!pageUrl) throw Error('Event page requires an absolute HTTPS URL without credentials');
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_HTML_BYTES)
    throw Error('Missing or oversized event page HTML');
  const $ = load(html);
  $(REMOVE).remove();
  if (exclude) $(exclude).remove();
  let roots = selector ? $(selector) : $('main, [role="main"]').first();
  if (!selector && !roots.length) roots = $('#content, #maincontent').first();
  if (!selector && !roots.length) roots = $('body');
  if (!roots.length) throw Error('Event page selection matched no content');
  const selected = new Set(roots.toArray());
  // Do not render a nested match twice when a selector includes both parent and child.
  roots = roots.filter(
    (_, node) =>
      !$(node)
        .parents()
        .toArray()
        .some((p) => selected.has(p)),
  );
  const urls = new Set();
  const registerUrl = (raw) => {
    const target = httpsUrl(raw, pageUrl);
    if (target) urls.add(target);
    return target;
  };
  const text = renderDocument(roots.toArray(), registerUrl, '\n\n---\n\n');
  const scopedScripts = new Set(roots.find(LD).toArray());
  const records = new Set();
  $(LD).each((_, script) => {
    let data;
    try {
      data = JSON.parse($(script).text());
    } catch {
      return;
    }
    for (const event of eventEntities(data)) {
      // Site-wide metadata can describe unrelated events. Outside the selected region,
      // only include an event that identifies this document.
      if (
        !scopedScripts.has(script) &&
        ![event.url, event['@id']].some((u) => {
          const normalized = httpsUrl(u, pageUrl);
          return normalized?.split('#')[0] === pageUrl.split('#')[0];
        })
      )
        continue;
      records.add(JSON.stringify(projectEventData(event, registerUrl)));
    }
  });
  const prepared = cleanLines(
    [text, records.size ? `Published event data (JSON-LD):\n${[...records].join('\n')}` : ''].join(
      '\n\n',
    ),
  );
  if (!prepared) throw Error('Event page selection contains no usable content');
  if (
    prepared.length > EXTRACTION_LIMITS.documentCharacters ||
    urls.size > EXTRACTION_LIMITS.documentUrls
  )
    throw Error('Prepared event page exceeds contract limits; select a smaller region');
  return { url: pageUrl, text: prepared, urls: [...urls] };
}

/** Construct and validate the request context. No fetching, model calls or storage. */
export function prepareExtractionContext({ source, pageUrl, checkedAt, pages }) {
  if (!Array.isArray(pages) || !pages.length || pages.length > EXTRACTION_LIMITS.documents)
    throw Error('Invalid number of event pages');
  if (typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt)))
    throw Error('Event preparation requires a reference timestamp');
  return parseExtractionContext({
    schemaVersion: EXTRACTION_VERSION,
    source,
    pageUrl: httpsUrl(pageUrl),
    checkedAt,
    timeZone: DEFAULT_TIME_ZONE,
    window: collectionWindow(checkedAt),
    documents: pages.map(prepareExtractionDocument),
  });
}
