// src/services/search/librarySearch.ts
import { SavedRecording } from '../storage/recordingLibrary';

/** Time-window filters offered as chips next to the search field. */
export type LibraryFilter = 'all' | 'today' | 'week' | 'month' | 'long' | 'short';

export interface HighlightRange {
  start: number;
  end: number;
}

export interface LibrarySearchHit {
  item: SavedRecording;
  score: number;
  /** Byte-accurate ranges inside `item.name` to highlight. */
  ranges: HighlightRange[];
  /** True when the hit came from a date / format token rather than the name. */
  metaOnly: boolean;
}

export interface LibrarySearchResult {
  hits: LibrarySearchHit[];
  /** Tokens that matched nothing at all (shown as "no match for …"). */
  unmatched: string[];
  total: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const trim = (value: unknown): string => {
  const s = typeof value === 'string' ? value : '';
  return s.trim();
};

/** Lower-cased, diacritic-stripped, whitespace-collapsed form of a label. */
export function normalize(value: string): string {
  return trim(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\-–—/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(query: string): string[] {
  const parts = normalize(query)
    .split(' ')
    .map((p) => p.replace(/[^\p{L}\p{N}.]+/gu, ''))
    .filter((p) => p.length > 0);
  return Array.from(new Set(parts)).slice(0, 8);
}

/** Words of the normalized label, plus the alpha/numeric halves of mixed ones. */
function expandWords(base: string): string[] {
  const words = base.split(' ').filter((w) => w.length > 0);
  const out = [...words];
  for (const w of words) {
    if (/\d/.test(w) && /[a-z]/i.test(w)) {
      out.push(...(w.match(/[^0-9]+/g) ?? []));
    }
  }
  return out.filter((w) => w.length > 0);
}

/**
 * Standalone numbers in the label ("Take 47" -> 47, "2026-09-28" -> 2026, 09,
 * 28). Generated names are numbered, so "47" must find "Take 47" - but only
 * real number *words*, never digits embedded inside another word, or every
 * query ending in a digit would match every take.
 */
function numberIndex(base: string): string[] {
  return Array.from(new Set(base.match(/(?<![0-9])[0-9]{1,8}(?![0-9])/g) ?? []));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Date strings a take can be found by (locale-independent + local style). */
export function dateIndex(createdAt: number): string[] {
  const d = new Date(createdAt);
  const out = new Set<string>([
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`,
    normalize(d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })),
    normalize(d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })),
    normalize(d.toLocaleDateString([], { weekday: 'long' })),
    `${d.getFullYear()}`,
  ]);
  // "3:47pm" style tokens, which is how the takes are named by default.
  const local = normalize(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  if (local) out.add(local.replace(/\s+/g, ''));
  out.add(local.replace(/[:\s]/g, ''));
  return Array.from(out).filter(Boolean);
}

/** "1m20s" / "80s" / "01:20" all find a 80 second take. */
export function durationIndex(durationMs: number): string[] {
  const totalSec = Math.round(Math.max(0, durationMs) / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const out = new Set<string>([
    `${totalSec}s`,
    `${mins}m${secs > 0 ? `${pad2(secs)}` : ''}`,
    `${mins}:${pad2(secs)}`,
    `${pad2(mins)}:${pad2(secs)}`,
  ]);
  if (mins >= 1) out.add(`${mins}min`);
  if (totalSec >= 600) out.add(`${mins}m`);
  return Array.from(out);
}

/** Format / size tags a take can be found by, derived from what is stored. */
export function labelIndex(item: SavedRecording): string[] {
  const parts = (item.uri ?? '').split('?')[0].split('.');
  const ext = parts.length > 1 ? parts.pop()!.toLowerCase() : '';
  const out = new Set<string>([]);
  if (ext && ext.length <= 5) {
    out.add(ext);
    out.add(`.${ext}`);
  }
  const bytes = item.sizeBytes ?? 0;
  if (bytes > 0) {
    const mb = bytes / (1024 * 1024);
    out.add(mb >= 1 ? `${mb.toFixed(1)}mb` : `${Math.max(1, Math.round(bytes / 1024))}kb`);
  }
  return Array.from(out).filter(Boolean);
}

function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: HighlightRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** First literal occurrence of `token` (case-insensitive) in the raw label. */
function literalRange(rawName: string, token: string): HighlightRange | null {
  const idx = rawName.toLowerCase().indexOf(token);
  return idx < 0 ? null : { start: idx, end: idx + token.length };
}

/**
 * Subsequence match ("podacst" still finds "podcast"): returns the ranges of
 * the matched runs so the UI can underline what actually matched.
 */
/*
 * Fuzzy fallback ("podacst" still finds "Podcast"). It is tried per word of
 * the *shown* name - never across the whole label - so scattered letters do
 * not match, and the returned ranges index into what the user actually sees.
 */
function fuzzyWithin(word: string, wordStart: number, token: string): HighlightRange[] | null {
  const runs: HighlightRange[] = [];
  let i = 0;
  for (let c = 0; c < token.length; c++) {
    const ch = token[c];
    let found = -1;
    while (i < word.length) {
      if (word[i] === ch) {
        found = i;
        break;
      }
      i++;
    }
    if (found < 0) return null;
    const last = runs[runs.length - 1];
    if (last && last.end === wordStart + found) last.end = wordStart + found + 1;
    else runs.push({ start: wordStart + found, end: wordStart + found + 1 });
    i = found + 1;
  }
  // A typo or a dropped letter costs one extra gap; anything looser is noise.
  const span = runs[runs.length - 1].end - runs[0].start;
  if (span > token.length + 2 || runs.length > 2) return null;
  return runs;
}

function fuzzyRanges(rawName: string, token: string): HighlightRange[] | null {
  if (token.length < 4) return null;
  const lower = rawName.toLowerCase();
  // Typed "podacst" for "podcast": the letters are there but swapped, so a
  // forward scan cannot reach them. Adjacent transpositions are the single
  // most common typo, so they are tried as extra spellings of the token.
  const variants = [token];
  for (let i = 0; i + 1 < token.length; i++) {
    if (token[i] === token[i + 1]) continue;
    variants.push(token.slice(0, i) + token[i + 1] + token[i] + token.slice(i + 2));
  }

  let cursor = 0;
  for (const chunk of rawName.split(/\s+/)) {
    const word = chunk.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const at = word.length >= 3 ? lower.indexOf(word, cursor) : -1;
    cursor += chunk.length + 1;
    if (at < 0) continue;
    for (const variant of variants) {
      const hit = fuzzyWithin(word, at, variant);
      if (hit) return hit;
    }
  }
  return null;
}

export interface RelativeDay {
  start: number;
  end: number;
}

/** Local-midnight window for "today" / "this week" / "this month". */
export function dayWindow(filter: LibraryFilter, now = Date.now()): RelativeDay | null {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  switch (filter) {
    case 'today':
      return { start, end: start + DAY_MS };
    case 'week': {
      // Monday-anchored week, which is what people read as "this week".
      const dow = (d.getDay() + 6) % 7;
      return { start: start - dow * DAY_MS, end: start + DAY_MS };
    }
    case 'month':
      return { start, end: start + 31 * DAY_MS };
    default:
      return null;
  }
}

export function passesFilter(item: SavedRecording, filter: LibraryFilter): boolean {
  switch (filter) {
    case 'today':
    case 'week':
    case 'month': {
      const win = dayWindow(filter);
      if (!win) return true;
      return item.createdAt >= win.start && item.createdAt < win.end;
    }
    case 'long':
      return item.durationMs >= 60000;
    case 'short':
      return item.durationMs > 0 && item.durationMs < 10000;
    case 'all':
    default:
      return true;
  }
}

interface ScoredToken {
  token: string;
  score: number;
  ranges: HighlightRange[];
  metaOnly: boolean;
}

/**
 * `name` is the normalized label (matching), `rawName` the one that is shown
 * (so the highlight ranges index into what the user actually sees).
 */
function scoreToken(
  token: string,
  name: string,
  rawName: string,
  words: string[],
  numbers: string[],
  dates: string[],
  durations: string[],
  labels: string[]
): ScoredToken | null {
  const inName = name.includes(token);
  if (inName) {
    const exact = name === token;
    const prefix = name.startsWith(token);
    const wordStart = words.some(
      (w) => w === token || w.startsWith(token) || token.startsWith(w)
    );
    const range = literalRange(rawName, token);
    return {
      token,
      score: exact ? 1000 : prefix ? 820 : wordStart ? 740 : 620,
      ranges: range ? [range] : [],
      metaOnly: false,
    };
  }
  // Number token matching a numbered take: "47" finds "Take 47".
  if (/^\d+$/.test(token) && numbers.includes(token)) {
    const range = literalRange(rawName, token);
    return {
      token,
      score: 600,
      ranges: range ? [range] : [],
      metaOnly: false,
    };
  }
  if (dates.some((d) => d.includes(token) || token.includes(d))) {
    return { token, score: 420, ranges: [], metaOnly: true };
  }
  if (durations.some((d) => d === token || d.includes(token))) {
    return { token, score: 400, ranges: [], metaOnly: true };
  }
  if (labels.some((d) => d === token || d.includes(token))) {
    return { token, score: 380, ranges: [], metaOnly: true };
  }
  const fuzzy = fuzzyRanges(rawName, token);
  if (fuzzy) {
    return { token, score: 300, ranges: fuzzy, metaOnly: false };
  }
  return null;
}

/**
 * Search the library. Every token must match something (name, date, duration
 * or format), so "interview monday" narrows instead of widening. Results are
 * ranked: exact > prefix > word > substring > date/duration/format > fuzzy,
 * with recency as the tie-break.
 */
export function searchLibrary(
  recordings: SavedRecording[],
  query: string,
  filter: LibraryFilter = 'all'
): LibrarySearchResult {
  const tokens = tokenize(query);
  const window = dayWindow(filter);

  // Date / duration / format indexes are stable per take; computing them for
  // every keystroke would be wasteful, so they are built lazily per item and
  // only when a name match is not possible.
  const hits: LibrarySearchHit[] = [];
  const unmatched: string[] = [];

  for (const item of recordings) {
    if (!passesFilter(item, filter)) continue;
    if (tokens.length === 0) {
      // No query: the caller's sort decides, recency is the natural default.
      hits.push({ item, score: item.createdAt, ranges: [], metaOnly: false });
      continue;
    }
    const name = normalize(item.name);
    const rawName = String(item.name ?? '');
    const words = expandWords(name);
    const numbers = numberIndex(name);

    let total = 0;
    let metaOnly = true;
    const ranges: HighlightRange[] = [];
    let failed = false;

    for (const token of tokens) {
      let scored: ScoredToken | null;
      const wantsDate = /^\d/.test(token) || /(mon|tue|wed|thu|fri|sat|sun|today|yester|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)/.test(token);
      const wantsDuration = /^\d+[sm:]$/.test(token) || /^\d+m\d*$/.test(token) || /^\d+:\d\d$/.test(token);
      if (wantsDate || wantsDuration || /^\d+$/.test(token)) {
        scored = scoreToken(
          token,
          name,
          rawName,
          words,
          numbers,
          dateIndex(item.createdAt),
          wantsDuration ? durationIndex(item.durationMs) : [],
          labelIndex(item)
        );
      } else {
        scored = scoreToken(token, name, rawName, words, numbers, [], [], labelIndex(item));
      }
      if (!scored) {
        failed = true;
        if (!unmatched.includes(token)) unmatched.push(token);
        break;
      }
      total += scored.score;
      if (!scored.metaOnly) metaOnly = false;
      ranges.push(...scored.ranges);
    }
    if (failed) continue;
    if (window) total += 40; // an explicit filter is a strong signal
    // Recency is only ever a tie-break: at most 10 points, so a two-year-old
    // exact match still beats today's substring match.
    const recency = Math.max(0, 10 - (Date.now() - item.createdAt) / (100 * DAY_MS));
    hits.push({
      item,
      score: total + recency,
      ranges: mergeRanges(ranges),
      metaOnly,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return { hits, unmatched, total: recordings.length };
}
