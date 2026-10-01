/*
 * `npm run test:waveform` (tsx) - no jest, no Skia, no UI thread.
 *
 * This does NOT import the waveform component: importing it would pull React,
 * Skia and Reanimated into node, and Reanimated's worklet machinery is exactly
 * what is under test. Instead it extracts the worklet bodies from the component's
 * own source between the geometry markers below and executes that text
 * text verbatim, so the assertions run against the shipped code. Move or rename
 * a marker and this file fails loudly instead of quietly testing a copy.
 *
 * Why the code is written inline in the component in the first place: a worklet
 * may only call helpers the compiler can hoist into it. A function imported from
 * another module becomes a remote reference in `this.__closure` instead, and the
 * UI runtime throws "[Worklets] Tried to synchronously call a Remote Function"
 * the moment it is called synchronously - that is the crash this test guards
 * against, so the first assertion pins "the component imports no local module".
 * (Same-file helpers carrying a 'worklet' directive are hoisted and are fine;
 * the geometry is inlined anyway so the rule has no exceptions here.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = join(__dirname, '..', '..', 'src', 'components', 'studio', 'StudioWaveform.tsx');
const src = readFileSync(SOURCE, 'utf8');

/** Extract a `'worklet';` body from between two markers and make it callable. */
function extractWorklet(startMarker: string, endMarker: string, injected: string[]) {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker);
  if (from < 0 || to < 0 || to < from) {
    throw new Error(`markers ${startMarker} / ${endMarker} not found in StudioWaveform.tsx`);
  }
  const block = src.slice(from, to);
  const arrow = block.indexOf('=>');
  if (arrow < 0) throw new Error(`no arrow function inside ${startMarker}`);
  const open = block.indexOf('{', arrow);
  if (open < 0) throw new Error(`no body for the worklet in ${startMarker}`);
  // Brace-match the body. The two blocks contain no braces inside string
  // literals, which is the one rule this extractor relies on.
  let depth = 0;
  let close = -1;
  for (let i = open; i < block.length; i++) {
    const ch = block[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) throw new Error(`unbalanced braces in ${startMarker}`);
  let body = block.slice(open + 1, close);
  const directive = "'worklet';";
  if (!body.includes(directive)) throw new Error(`no 'worklet' directive inside ${startMarker}`);
  body = body.slice(body.indexOf(directive) + directive.length);
  // The only TypeScript in these bodies is the array/return annotations.
  body = body.replace(/:\s*number\[\]/g, '').replace(/:\s*WaveformGeometry/g, '');
  if (/:\s*(number|WaveformGeometry|string)/.test(body)) {
    throw new Error(`unhandled TypeScript annotation in ${startMarker} - extend the stripper`);
  }
  // One object in, destructured at the top: positional arguments are exactly
  // the kind of mistake this file is meant to catch, not make.
  const names = injected.join(', ');
  // eslint-disable-next-line no-new-func
  return new Function(`return function (c) {const {${names}} = c;${body}}`)();
}

const runGeometry = extractWorklet('/* === geometry:start === */', '/* === geometry:end === */', [
  'widthSV', 'pxPerSec', 'durationMs', 'quantMs', 'playheadMs', 'isRecording',
  'lod0', 'lod1', 'lod2', 'lod3', 'lod4', 'maxDeflection',
  'BAR_SPACING', 'PAD', 'PEAK_BUCKET_SEC', 'LOD_FACTORS', 'GROW_FRACTION',
]);
const runQuant = extractWorklet('/* === quant:start === */', '/* === quant:end === */', [
  'playheadMs', 'pxPerSec', 'BAR_SPACING', 'MIN_REBUILD_STEP_MS',
]);

let fail = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) fail++;
};

const sv = (v: any) => ({ value: v });
const consts = {
  BAR_SPACING: 3,
  PAD: 6,
  PEAK_BUCKET_SEC: 0.02,
  LOD_FACTORS: [1, 4, 16, 64, 256],
  GROW_FRACTION: 3,
  MIN_REBUILD_STEP_MS: 8,
};
const MAX_DEF = 25;
const FULL_TAKE = Math.round(60 / consts.PEAK_BUCKET_SEC); // 60 s of audio
const loud = (n: number, v = 200) => new Array<number>(n).fill(v);

const buildTables = (buckets: number[]) => {
  const tables = [buckets];
  for (let level = 1; level < consts.LOD_FACTORS.length; level++) {
    const f = consts.LOD_FACTORS[level];
    const out = new Array<number>(Math.ceil(buckets.length / f)).fill(0);
    for (let i = 0; i < buckets.length; i++) {
      const v = buckets[i];
      const k = (i / f) | 0;
      if (v > out[k]) out[k] = v;
    }
    tables.push(out);
  }
  return tables.map((value) => ({ value }));
};

/** Run the shipped geometry worklet with the given state. */
const geometry = (opts: {
  buckets?: number[];
  pps: number;
  playMs: number;
  durationMs: number;
  width?: number;
  recording?: boolean;
}) => {
  const tables = buildTables(opts.buckets ?? []);
  const ctx: any = {
    widthSV: sv(opts.width ?? 320),
    pxPerSec: sv(opts.pps),
    durationMs: sv(opts.durationMs),
    quantMs: sv(opts.playMs),
    playheadMs: sv(opts.playMs),
    isRecording: sv(!!opts.recording),
    lod0: tables[0], lod1: tables[1], lod2: tables[2], lod3: tables[3], lod4: tables[4],
    maxDeflection: MAX_DEF,
    ...consts,
  };
  return runGeometry(ctx);
};

// ---- 1. the crash this whole shape exists to avoid -------------------------
{
  const imports = [...src.matchAll(/^import[^;]*from '(\.[^']*)'/gm)].map((m) => m[1]);
  ok(imports.length === 0,
     `the waveform component imports nothing from another module, so no worklet can call a remote function (found: ${imports.join(', ') || 'none'})`);
  ok(!/from '\.\.\/|from '\.\//.test(src), 'no relative imports in StudioWaveform.tsx');
  ok(!/\bimport\(/.test(src), 'no dynamic imports either');
}

// ---- 2. no hole between the playhead and the wave while recording ---------
{
  const buckets = loud(FULL_TAKE);
  const headMs = 60_000;
  for (const pps of [12, 60, 240, 600]) {
    const g = geometry({ buckets, pps, playMs: headMs, durationMs: 61_000, recording: true });
    const rightMost = g.pastXs.length ? Math.max(...g.pastXs) : -1;
    const gapPx = 6 + 160 - rightMost;
    ok(g.pastAmps.length > 0 && gapPx <= 3.0001,
       `last drawn bar reaches the playhead (pps=${pps}, gap=${gapPx.toFixed(2)}px, bars=${g.pastAmps.length})`);
    const sorted = [...g.pastXs].sort((a: number, b: number) => a - b);
    let maxJump = 0;
    for (let i = 1; i < sorted.length; i++) maxJump = Math.max(maxJump, sorted[i] - sorted[i - 1]);
    ok(maxJump <= 3.0001, `bars are contiguous, not dotted (pps=${pps}, maxJump=${maxJump.toFixed(2)}px)`);
  }
}

// ---- 3. bars finer than the peak table repeat the bucket (fills forward) --
{
  const buckets = loud(FULL_TAKE);
  const g = geometry({ buckets, pps: 600, playMs: 0, durationMs: 61_000 });
  ok(g.futureAmps.length > 40, `fine zoom fills forward (${g.futureAmps.length} bars in a 320pt window)`);
  ok(g.futureAmps.every((a: number) => a > 1.5), 'every filled bar carries the bucket amplitude');
}

// ---- 4. level of detail actually caps the work per rebuild ---------------
{
  const buckets = loud((90 * 60) / consts.PEAK_BUCKET_SEC); // 90 minutes
  const g = geometry({ buckets, pps: 600, playMs: 2_700_000, durationMs: 5_400_000 });
  ok(g.reads <= g.pastAmps.length + g.futureAmps.length + 8,
     `one read per bar at high zoom (${g.reads} reads for ${g.pastAmps.length + g.futureAmps.length} bars)`);
  const naive = Math.ceil(320 / 3) * Math.ceil(3 / 600 / consts.PEAK_BUCKET_SEC + 1);
  ok(g.reads < naive, `LOD beats the naive per-bucket scan (${g.reads} < ${naive})`);
  const wide = geometry({ buckets, pps: 12, playMs: 2_700_000, durationMs: 5_400_000 });
  const perBar = wide.reads / Math.max(1, wide.pastAmps.length + wide.futureAmps.length);
  ok(perBar <= 64, `coarse levels cap the scan per bar (${perBar.toFixed(1)} reads/bar)`);
}

// ---- 5. the grow-in ramp only touches the head bar -----------------------
{
  const buckets = loud(FULL_TAKE);
  // 19 ms into a 20 ms bucket, so the ramp is mid-flight for a long grow window.
  const headMs = 59_999;
  const step = Math.max((consts.BAR_SPACING / 240) * 1000, consts.MIN_REBUILD_STEP_MS);
  const quant = Math.round(headMs / step) * step;
  const geo = (growFraction: number, recording = true) => {
    const tables = buildTables(buckets);
    const c = {
      widthSV: sv(320), pxPerSec: sv(240), durationMs: sv(61_000), quantMs: sv(quant),
      playheadMs: sv(headMs), isRecording: sv(recording), maxDeflection: MAX_DEF,
      ...consts, GROW_FRACTION: growFraction,
    } as any;
    return runGeometry({ ...c, lod0: tables[0], lod1: tables[1], lod2: tables[2], lod3: tables[3], lod4: tables[4] });
  };
  const full = geo(0);        // ramp finished (age >= 0 -> factor 1)
  const mid = geo(1);         // 19 ms of a 60 ms window -> 0.95
  const early = geo(10);      // 19 ms of a 600 ms window -> floored at 0.2
  ok(full.pastAmps.length === mid.pastAmps.length, 'the ramp never drops bars');
  const last = full.pastAmps.length - 1;
  ok(mid.pastAmps[last] < full.pastAmps[last], 'the head bar is shorter mid-ramp');
  ok(early.pastAmps[last] < mid.pastAmps[last], 'and it grows monotonically as its bucket fills');
  const differing = mid.pastAmps.filter((a: number, i: number) => Math.abs(a - full.pastAmps[i]) > 0.001);
  ok(differing.length >= 1 && differing.length <= 3, `only the head bar(s) are ramped (${differing.length})`);
  const preview = geo(10, false);
  ok(preview.pastAmps.every((a: number, i: number) => Math.abs(a - full.pastAmps[i]) < 0.001),
     'no ramp while previewing');

  // Within a single rebuild window (quantised head held fixed) the head bar must
  // rise monotonically as its bucket fills. Across windows the head bar is chosen
  // by the quantised position, so the ramp is evaluated at most one step late -
  // that is the deliberate trade for not rebuilding paths 60 times a second.
  const at = (playMs: number) => {
    const tables = buildTables(loud(3000));
    const c = {
      widthSV: sv(320), pxPerSec: sv(240), durationMs: sv(61_000), quantMs: sv(60000),
      playheadMs: sv(playMs), isRecording: sv(true), maxDeflection: MAX_DEF, ...consts,
    } as any;
    const r = runGeometry({ ...c, lod0: tables[0], lod1: tables[1], lod2: tables[2], lod3: tables[3], lod4: tables[4] });
    return { head: r.pastAmps[r.pastAmps.length - 1], full: MAX_DEF * (200 / 255), count: r.pastAmps.length };
  };
  const fresh = at(59_981);   // 1 ms into the bucket
  const ageing = at(59_995);  // 15 ms in
  const done = at(60_001);    // ramp window (3 x bucket) passed
  ok(fresh.head < ageing.head, 'a brand new bucket starts smaller than an ageing one');
  ok(ageing.head < done.head, 'and it reaches full height on schedule');
  ok(Math.abs(done.head - done.full) < 0.001, 'past the ramp the head bar is at full height');
  ok(fresh.count === ageing.count && ageing.count === done.count,
     'ramping never changes how many bars are drawn');

  // The ramp must never overshoot or delete a bar at any head position.
  let overshoot = 0;
  let missing = 0;
  for (let ms = 59_980; ms <= 60_020; ms += 1) {
    const r = at(ms);
    if (r.head > r.full + 0.001) overshoot++;
    if (r.count < 1) missing++;
  }
  ok(overshoot === 0, 'the ramp never makes a bar taller than its peak');
  ok(missing === 0, 'the head bar is always present while recording');
}

// ---- 6. path rebuilds are quantised -------------------------------------
{
  const q = (playMs: number, pps: number) =>
    runQuant({
      ...consts,
      playheadMs: sv(playMs),
      pxPerSec: sv(pps),
    });
  ok(q(10_000, 12) === q(10_007, 12), `sub-pixel moves are skipped at low zoom (${q(10_000, 12)} == ${q(10_007, 12)})`);
  ok(q(10_000 + (3 / 600) * 1000, 600) - q(10_000, 600) === 8,
     'the rebuild step is floored at 8 ms, not one pixel at 5 ms');
  ok(q(10_001, 600) === q(10_000, 600), 'sub-step motion at high zoom still skips');
  ok(Number.isFinite(q(0, 0)), 'quantise is safe at zero zoom');
}

// ---- 7. degenerate inputs never throw ----------------------------------
{
  ok(geometry({ buckets: [], pps: 240, playMs: 0, durationMs: 0 }).pastAmps.length === 0, 'empty table returns nothing');
  ok(geometry({ buckets: loud(10), pps: 240, playMs: 0, durationMs: 1000, width: 0 }).pastAmps.length === 0, 'zero width returns nothing');
  ok(geometry({ buckets: loud(10), pps: 240, playMs: 1000, durationMs: -5 }).pastAmps.length === 0, 'negative duration returns nothing');
  ok(geometry({ buckets: loud(10), pps: 0, playMs: 1000, durationMs: 5000 }).pastAmps.length === 0, 'zero zoom returns nothing');
}

console.log(fail === 0 ? 'ALL WAVEFORM TESTS PASSED' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
