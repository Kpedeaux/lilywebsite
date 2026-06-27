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
 *   2. Resolves each encrypted Google link to the real article URL (follows redirect).
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

// Resolve a Google News redirect link to the underlying article URL.
async function resolveLink(gLink) {
  try {
    const r = await fetch(gLink, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (r.url && !/news\.google\.com/.test(r.url)) return r.url;
    // Fallback: some responses embed the destination in a JS/meta redirect.
    const body = await r.text();
    const m =
      body.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*url=([^"'>]+)/i) ||
      body.match(/data-n-au=["']([^"']+)["']/i) ||
      body.match(/rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
    if (m && /^https?:/.test(m[1]) && !/news\.google\.com/.test(m[1])) return m[1];
    return null;
  } catch {
    return null;
  }
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
    if (backfill) console.log(`window ${q.match(/after:(\S+)/)?.[1]} → ${found.size} total so far`);
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
            <a class="story__link" href="${url}" target="_blank" rel="noopener">Read the full story →</a>
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
