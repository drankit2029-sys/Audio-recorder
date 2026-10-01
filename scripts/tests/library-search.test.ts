/*
 * Plain `npm run test:search` (tsx) - no jest needed. Runs the real shipping
 * search module against a synthetic library, including the ranking rules the
 * UI relies on (AND semantics, exact > fuzzy, recency only as a tie-break).
 */
import {
  searchLibrary,
  normalize,
  tokenize,
  durationIndex,
  dateIndex,
  passesFilter,
} from '../../src/services/search/librarySearch';
type R = { id: string; name: string; uri: string; sizeBytes: number; durationMs: number; createdAt: number };
const now = Date.now();
const day = 86400000;
const items: R[] = [
  { id: '1', name: 'Podcast Intro Take 3', uri: 'file:///t/Podcast_Intro_Take_3.wav', sizeBytes: 5_200_000, durationMs: 80_000, createdAt: now - day * 0 },
  { id: '2', name: 'Voice Memo 2026-09-28', uri: 'file:///t/Voice_Memo_2026-09-28.m4a', sizeBytes: 300_000, durationMs: 12_500, createdAt: now - day * 3 },
  { id: '3', name: 'Interview - Priya (edit)', uri: 'file:///t/Interview_Priya_edit.aac', sizeBytes: 88_000_000, durationMs: 3_600_000, createdAt: now - day * 40 },
  { id: '4', name: 'Take 47', uri: 'file:///t/Take_47.wav', sizeBytes: 1_000_000, durationMs: 9_000, createdAt: now - day * 200 },
  { id: '5', name: 'résumé draft', uri: 'file:///t/resume_draft.wav', sizeBytes: 100_000, durationMs: 30_000, createdAt: now - day * 1 },
];
let fail = 0;
const ok = (cond: boolean, label: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) fail++; };

ok(normalize('Take_47') === 'take 47', 'normalize folds separators');
ok(JSON.stringify(tokenize('  Podcast   EDIT ')) === '["podcast","edit"]', 'tokenize dedupes+lowercases');

let r = searchLibrary(items, 'podcast');
ok(r.hits.length === 1 && r.hits[0].item.id === '1', 'name substring match');
const firstHit = r.hits[0];
ok(firstHit.ranges.length >= 1 && firstHit.item.name.slice(firstHit.ranges[0].start, firstHit.ranges[0].end) === 'Podcast', 'highlight range covers the match');

r = searchLibrary(items, 'intro take');
ok(r.hits.length === 1 && r.hits[0].item.id === '1', 'all tokens must match (AND)');

r = searchLibrary(items, '47');
ok(r.hits.some(h => h.item.id === '4'), 'number token finds "Take 47"');

r = searchLibrary(items, 'priya wav');
ok(r.hits.length === 0, 'AND semantics: priya is not a wav take');
r = searchLibrary(items, 'interview aac');
ok(r.hits.length === 1 && r.hits[0].item.id === '3', 'format token matches by extension');

r = searchLibrary(items, 'resume');
ok(r.hits.some(h => h.item.id === '5'), 'diacritic-insensitive match (resume -> résumé)');

r = searchLibrary(items, '80s');
ok(r.hits.length === 1 && r.hits[0].item.id === '1', 'duration token "80s"');
r = searchLibrary(items, '1m20');
ok(r.hits.length === 1 && r.hits[0].item.id === '1', 'duration token "1m20"');

const iso = new Date(now - day * 3).toISOString().slice(0, 10);
r = searchLibrary(items, iso);
ok(r.hits.length === 1 && r.hits[0].item.id === '2', `iso date token ${iso}`);

r = searchLibrary(items, 'podacst');
ok(r.hits.length === 1 && r.hits[0].item.id === '1', 'fuzzy fallback for a typo');

r = searchLibrary(items, 'zzzz');
ok(r.hits.length === 0 && r.unmatched.includes('zzzz'), 'unmatched tokens reported');

r = searchLibrary(items, 'take 3');
ok(r.hits[0].item.id === '1', 'ranking puts the strongest match first');

ok(passesFilter(items[0], 'today'), 'today filter includes a take from today');
ok(!passesFilter(items[1], 'today'), 'today filter excludes a 3-day-old take');
ok(passesFilter(items[2], 'long'), '1 min + filter');
ok(passesFilter(items[3], 'short'), 'under 10s filter');
r = searchLibrary(items, '', 'long');
ok(r.hits.length === 2, 'filter-only search (no query)');

r = searchLibrary(items, 'nonexistentterm podcast');
ok(r.hits.length === 0, 'bogus token never widens the result set');
console.log(durationIndex(80_000).join(','), '|', dateIndex(now - day*3).slice(0,3).join(','));
// ---- 8. the strip can be left (contract on the shipped source text) -------
// These three behaviours were the bug: search could not be turned off, and Back
// quit the app instead of stepping out of it. They need a device to *feel*, but
// each one is a line of source that must exist, so they are asserted here.
{
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const root = join(__dirname, '..', '..', 'src');
  const bar = readFileSync(join(root, 'components', 'library', 'LibrarySearchBar.tsx'), 'utf8');
  const screen = readFileSync(join(root, 'screens', 'LibraryScreen.tsx'), 'utf8');
  const hook = readFileSync(join(root, 'services', 'search', 'useLibrarySearch.ts'), 'utf8');

  ok(bar.includes('onHide'), 'the search bar exposes a hide control');
  ok(/onFocusChange=\{\(isFocused\)/.test(screen),
     'the screen tracks field focus, so Back knows whether the keyboard is up');
  ok(/searchInputFocusedRef\.current = isFocused/.test(screen), 'and the flag it tracks is the same one Back reads');
  ok(/ChevronDown size=\{17\}/.test(bar), 'the hide control renders an icon');
  ok(/if \(focused\) \{/m.test(bar) && bar.includes('onHide();'), 'Backspace on an empty, unfocused field hides the strip');
  ok(screen.includes('{searchVisible ? ('), 'the strip is rendered conditionally, not always');
  ok(/setSearchVisible\(false\)/.test(screen), 'the screen can close the strip');
  const backIdx = screen.indexOf('const onBack = () => {');
  const backBlock = screen.slice(backIdx, screen.indexOf('const sub = BackHandler', backIdx));
  const hideAt = backBlock.indexOf('setSearchVisible(false)');
  const editAt = backBlock.indexOf('if (isEditMode) {');
  ok(hideAt > 0 && editAt > 0 && hideAt < editAt,
     'Back hides the search strip before it can reach "exit the app"');
  ok(backBlock.indexOf('setSearchText') < hideAt, 'Back clears the query before it hides the strip');
  ok(/store.getBoolean\(OPEN_KEY\)/.test(hook) && /store.set\(OPEN_KEY/.test(hook),
     'the open/closed choice is persisted, so search does not force itself back on');
  ok(!/124, ?92, ?255|7C5CFF|A78BFA|D6C9FF/i.test(bar + screen + readFileSync(join(root, 'components', 'library', 'RecordingCard.tsx'), 'utf8')),
     'no violet left anywhere in the library search surface');
}

console.log(fail === 0 ? 'ALL SEARCH TESTS PASSED' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
