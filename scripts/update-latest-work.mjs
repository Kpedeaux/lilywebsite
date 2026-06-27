#!/usr/bin/env node
/**
 * update-latest-work.mjs
 * -----------------------------------------------------------------------------
 * Keeps Lily's "Latest Work" page current from Google News RSS.
 *
 *   node scripts/update-latest-work.mjs            # daily incremental (recent window)
 *   node scripts/update-latest-work.mjs --backfill # deep month-by-month historical crawl
 *
 * What it does:
 *   1. Queries Google News RSS for her byline.
 *   2. Resolves each encrypted Google link to the real article URL.
 *   3. Keeps only articles from her known outlets (allowlist) and drops duplicates.
 *   4. Merges into assets/data/articles.json (the site's own canonical archive).
 *   5. Regenerates the cards in latest-work.html between the STORIES markers.
 *
 * No external dependencies — Node 18+ (global fetch). Tested target: Node 20.
 * -----------------------------------------------------------------------------
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/* ----------------------------- CONFIG --------------------------------------- */

// Search phrase. Quotes force the exact name; the extra terms bias toward her beat.
const QUERY = '"Lily Cummings" (WWL OR "New Orleans" OR Louisiana)';

// Only keep articles published on these domains (her outlets / syndication partners).
// Anything else (e.g. a same-name journalist elsewhere) is discarded.
const OUTLET_ALLOWLIST = ['yahoo.com', 'msn.com', 'wwltv.com', 'aol.com'];

// How a given host should be labelled on the card. Her print work currently
// originates at WWL-TV and is syndicated out, so Yahoo/MSN are shown as such.
// Edit these labels freely.
const SOURCE_LABELS = {
  'yahoo.com': 'WWL-TV via Yahoo',
  'aol.com': 'WWL-TV via AOL',
  'msn.com': 'WWL-TV via MSN',
  'wwltv.com': 'WWL-TV',
};

// Map a URL path keyword to a friendly beat tag shown on the card.
const BEAT_RULES = [
  [/politic|election|legislat|council/i, 'Politics'],
  [/weather|storm|hurricane|tropical|flood/i, 'Weather'],
  [/crime|police|court|trial/i, 'Crime & Courts'],
  [/health|hospital/i, 'Health'],
  [/business|econom|market/i, 'Business'],
];
const DEFAULT_BEAT = 'Local';

// Backfill range. Adjust START_YEAR/MONTH to go further back.
const BACKFILL_START = { year: 2019, month: 6 };

// Files (relative to repo root, where the Action runs).
const DATA_FILE = 'assets/data/articles.json';
const PAGE_FILE = 'latest-work.html';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ----------------------------- HELPERS -------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

function escapeHtml(s = '') {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function allowed(url) {
  const h = hostOf(url);
  return OUTLET_ALLOWLIST.some((d) => h === d || h.endsWith('.' + d));
}

function sourceLabel(url) {
  const h = hostOf(url);
  const key = Object.keys(SOURCE_LABELS).find((d) => h === d || h.endsWith('.' + d));
  return key ? SOURCE_LABELS[key] : (h || 'News');
}

function beatFor(url, title) {
  const hay = url + ' ' + title;
  for (const [re, label] of BEAT_RULES) if (re.test(hay)) return label;
  return DEFAULT_BEAT;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = ''; // drop tracking params for dedupe
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '').toLowerCase();
  } catch {
    return (url || '').toLowerCase();
  }
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/* ----------------------------- FETCH + PARSE -------------------------------- */

function rssUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', ...opts });
  return { ok: res.ok, status: res.status, finalUrl: res.url, text: await res.text() };
}

function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const block of blocks) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? decodeEntities(m[1]) : '';
    };
    let title = pick('title');
    const gLink = pick('link');
    const pubDate = pick('pubDate');
    const description = pick('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Google appends " - Source" to titles; strip the trailing source.
    title = title.replace(/\s+-\s+[^-]+$/, '').trim();
    if (gLink) items.push({ title, gLink, pubDate, description });
  }
  return items;
}

/* --- Google News link decoding ---------------------------------------------
 * Google wraps article links in an encrypted token. We resolve it three ways,
 * cheapest first:
 *   1. Offline decode — older tokens embed the destination URL directly.
 *   2. batchexecute — Google's internal endpoint returns the URL for new tokens.
 *   3. Redirect follow — last-resort fallback.
 * ------------------------------------------------------------------------- */

function b64ToBytes(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function gnArticleId(gLink) {
  try {
    const u = new URL(gLink);
    if (!u.hostname.includes('news.google.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('articles');
    if (i !== -1 && parts[i + 1]) return parts[i + 1];
  } catch {
    /* ignore */
  }
  return null;
}

function offlineDecode(id) {
  try {
    let b = b64ToBytes(id);
    if (b[0] === 0x08 && b[1] === 0x13 && b[2] === 0x22) b = b.subarray(3);
    const n = b.length;
    if (n >= 3 && b[n - 3] === 0xd2 && b[n - 2] === 0x01 && b[n - 1] === 0x00) b = b.subarray(0, n - 3);
    let len = b[0];
    let offset = 1;
    if (len >= 0x80) {
      len = (b[1] << 7) | (b[0] & 0x7f);
      offset = 2;
    }
    const str = b.subarray(offset, offset + len).toString('utf8');
    return /^https?:\/\//.test(str) ? str : null;
  } catch {
    return null;
  }
}

function unescapeUrl(u) {
  return u
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003f/gi, '?')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/');
}

async function batchExecuteDecode(id) {
  try {
    const page = await fetch(`https://news.google.com/rss/articles/${id}`, { headers: { 'User-Agent': UA } });
    const html = await page.text();
    const sig = html.match(/data-n-a-sg="([^"]+)"/);
    const ts = html.match(/data-n-a-ts="([^"]+)"/);
    if (!sig || !ts) return null;
    const reqArr = [
      [
        [
          'Fbv4je',
          `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts[1]},"${sig[1]}"]`,
        ],
      ],
    ];
    const body = 'f.req=' + encodeURIComponent(JSON.stringify(reqArr));
    const ex = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': UA },
      body,
    });
    const txt = await ex.text();
    const m = txt.match(/garturlres\\",\\"(.*?)\\"/) || txt.match(/"garturlres","(https?:[^"]+)"/);
    return m ? unescapeUrl(m[1]) : null;
  } catch {
    return null;
  }
}

async function resolveLink(gLink) {
  const id = gnArticleId(gLink);
  if (id) {
    const off = offlineDecode(id);
    if (off) return off;
    const on = await batchExecuteDecode(id);
    if (on) return on;
  }
  try {
    const r = await fetch(gLink, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (r.url && !/news\.google\.com/.test(r.url)) return r.url;
  } catch {
    /* ignore */
  }
  return null;
}

function monthWindows(start) {
  const out = [];
  const now = new Date();
  let y = start.year;
  let m = start.month;
  while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth() + 1)) {
    const after = `${y}-${String(m).padStart(2, '0')}-01`;
    const nm = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
    const before = `${nm.y}-${String(nm.m).padStart(2, '0')}-01`;
    out.push({ after, before });
    y = nm.y;
    m = nm.m;
  }
  return out;
}

/* ----------------------------- COLLECT -------------------------------------- */

async function collect({ backfill }) {
  const queries = [];
  if (backfill) {
    for (const w of monthWindows(BACKFILL_START)) {
      queries.push(`${QUERY} after:${w.after} before:${w.before}`);
    }
  } else {
    queries.push(QUERY); // recent rolling window
  }

  const found = new Map(); // normalizedUrl -> article
  let skippedUnresolved = 0;
  let droppedOutlet = 0;
  let loggedSample = false;

  for (const q of queries) {
    let parsed = [];
    try {
      const { text, ok } = await fetchText(rssUrl(q));
      if (!ok) continue;
      parsed = parseRssItems(text);
    } catch (e) {
      console.warn('RSS fetch failed for window:', q, e.message);
      continue;
    }

    for (const it of parsed) {
      const real = await resolveLink(it.gLink);
      await sleep(250); // be gentle
      if (!real) {
        skippedUnresolved++;
        continue;
      }
      if (!loggedSample) {
        console.log('Sample resolved link:', real);
        loggedSample = true;
      }
      if (!allowed(real)) {
        droppedOutlet++;
        continue;
      }
      const key = normalizeUrl(real);
      if (found.has(key)) continue;
      const iso = it.pubDate ? new Date(it.pubDate).toISOString().slice(0, 10) : '';
      found.set(key, {
        title: it.title,
        url: real,
        source: sourceLabel(real),
        beat: beatFor(real, it.title),
        date: iso,
        summary: it.description,
      });
    }
    if (backfill) console.log(`window ${q.match(/after:(\S+)/)?.[1]} -> ${found.size} total so far`);
  }

  console.log(`Collected ${found.size} articles (skipped ${skippedUnresolved} unresolved, dropped ${droppedOutlet} off-outlet).`);
  return [...found.values()];
}

/* ----------------------------- RENDER --------------------------------------- */

function renderCards(articles) {
  return articles
    .map((a, i) => {
      const feature = i === 0 ? ' story--feature' : '';
      const beat = a.beat ? `<span class="story__source story__beat">${escapeHtml(a.beat)}</span>` : '';
      const date = a.date ? `<span class="story__date">${escapeHtml(fmtDate(a.date))}</span>` : '';
      const summary = a.summary ? `\n            <p>${escapeHtml(a.summary)}</p>` : '';
      const url = escapeHtml(a.url);
      return `          <article class="story${feature}">
            <div class="story__meta">
              ${beat}<span class="story__source">${escapeHtml(a.source)}</span>${date}
            </div>
            <h3><a href="${url}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a></h3>${summary}
            <a class="story__link" href="${url}" target="_blank" rel="noopener">Read the full story &rarr;</a>
          </article>`;
    })
    .join('\n\n');
}

async function writePage(articles, updatedIso) {
  let html = await readFile(PAGE_FILE, 'utf8');
  const cards = `\n        <div class="stories">\n${renderCards(articles)}\n        </div>\n        `;

  html = html.replace(
    /(<!-- STORIES:START[\s\S]*?-->)[\s\S]*?(<!-- STORIES:END -->)/,
    (_, start, end) => `${start}${cards}${end}`,
  );

  const stamp = fmtDate(updatedIso);
  html = html.replace(
    /(<!-- UPDATED:START -->)[\s\S]*?(<!-- UPDATED:END -->)/,
    (_, s, e) => `${s}Last updated ${escapeHtml(stamp)}${e}`,
  );

  await writeFile(PAGE_FILE, html);
}

/* ----------------------------- MAIN ----------------------------------------- */

async function main() {
  const backfill = process.argv.includes('--backfill');

  let store = { updated: '', articles: [] };
  if (existsSync(DATA_FILE)) {
    try {
      store = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    } catch {
      /* start fresh on parse error */
    }
  }

  const existing = new Map((store.articles || []).map((a) => [normalizeUrl(a.url), a]));
  const fresh = await collect({ backfill });

  let added = 0;
  for (const a of fresh) {
    const key = normalizeUrl(a.url);
    if (!existing.has(key)) {
      existing.set(key, a);
      added++;
    }
  }

  const articles = [...existing.values()]
    .filter((a) => a.url && a.title)
    .sort((x, y) => (y.date || '').localeCompare(x.date || ''));

  const updated = new Date().toISOString().slice(0, 10);
  await writeFile(DATA_FILE, JSON.stringify({ updated, articles }, null, 2) + '\n');
  await writePage(articles, updated);

  console.log(`Done. ${added} new article(s) added; ${articles.length} total in archive.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
