/*
 * scripts/verify/audit-worklet-closures.js
 *
 * A guard for a crash class that neither `tsc` nor Metro can see:
 *
 *   Error: [Worklets] Tried to synchronously call a Remote Function. Called "someHelper"
 *
 * `react-native-worklets/plugin` hoists a helper into a worklet's own init data when the
 * helper is defined *in the same file* and carries a `'worklet'` directive. A helper that is
 * imported from another module is instead captured into `this.__closure` as a remote
 * reference, and unless the native side received a matching `registerRemoteFunction` the value
 * is the library's unpacker stub, whose body is exactly that throw. Calling one synchronously
 * from `useDerivedValue`/`useAnimatedStyle` therefore crashes at runtime while compiling and
 * bundling perfectly.
 *
 * This runs the project's real plugin over every file that carries worklets and reports any
 * worklet that *calls* a captured identifier which is not a same-file `'worklet'` function.
 *
 *   node scripts/verify/audit-worklet-closures.js            # all worklet-bearing files
 *   node scripts/verify/audit-worklet-closures.js App.tsx    # or specific paths
 *
 * Exits 1 when something is unsafe. Needs `@babel/core`, which is present as a transitive
 * dependency of `expo`; it is not wired into `npm test` on purpose, so a hoisting change in
 * node_modules cannot break CI.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let babel;
try {
  babel = require('@babel/core');
} catch {
  console.error('audit skipped: @babel/core is not installed (run `npm install` first)');
  process.exit(0);
}
const workletPlugin = require('react-native-worklets/plugin');

const DEFAULT_FILES = [
  'App.tsx',
  'src/components/audio/SaveRecordingModal.tsx',
  'src/components/library/LibrarySearchBar.tsx',
  'src/components/library/RecordingCard.tsx',
  'src/components/library/RenameRecordingModal.tsx',
  'src/components/meter/AudioMeter.tsx',
  'src/components/prompter/TeleprompterDeck.tsx',
  'src/components/studio/StudioTimer.tsx',
  'src/components/studio/StudioWaveform.tsx',
  'src/components/studio/WaveformZoomControl.tsx',
  'src/services/audio/useStudioSession.ts',
];

const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;
let problems = 0;

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.log(`skip ${rel} (not found)`);
    continue;
  }
  const src = fs.readFileSync(abs, 'utf8');
  let out;
  try {
    out = babel.transformSync(src, {
      filename: abs,
      babelrc: false,
      configFile: false,
      presets: [],
      plugins: [
        ['@babel/plugin-transform-typescript', { isTSX: rel.endsWith('.tsx'), allowDeclareFields: true }],
        workletPlugin,
      ],
    }).code;
  } catch (e) {
    console.log(`ERROR ${rel}: ${e.message}`);
    problems++;
    continue;
  }

  // Identifiers this file defines as a `'worklet'` function: the plugin hoists those, so a
  // worklet may call them. `const pad2 = (n) => { 'worklet'; ... }` and `function x() {...}`.
  const hoisted = new Set();
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*\([^)]*\)[^={]*=>\s*\{\s*'worklet';/gm)) {
    hoisted.add(m[1]);
  }
  for (const m of src.matchAll(/^(?:export\s+)?function\s+([A-Za-z0-9_$]+)[\s\S]{0,400}?\{\s*'worklet';/gm)) {
    hoisted.add(m[1]);
  }

  // Everything else a worklet could call and would then be reaching for across a module edge.
  const importedNames = new Set();
  for (const m of src.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'(\.[^']*)'/gm)) {
    if (!m[2].startsWith('.')) continue;
    m[1]
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/).pop().trim())
      .filter(Boolean)
      .forEach((n) => importedNames.add(n));
  }
  for (const m of src.matchAll(/^import\s+([A-Za-z0-9_$]+)\s+from\s*'(\.[^']*)'/gm)) importedNames.add(m[1]);

  const worklets = [...out.matchAll(/code:\s*"(function[\s\S]*?)",\s*\n/gs)].map((m) => m[1]);
  const bad = new Set();
  for (const code of worklets) {
    const m = code.match(/const\{([^}]*)\}=this\.__closure/);
    if (!m) continue;
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (!name || hoisted.has(name)) continue;
      const calledInside = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`).test(code);
      if (!calledInside) continue; // captured data (numbers, arrays, shared values) is fine
      const importedFromLocalModule = importedNames.has(name);
      const locallyDefinedFunction =
        new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=\\s*\\(?[^;]*=>`, 'm').test(src) ||
        new RegExp(`^(?:export\\s+)?function\\s+${name}\\b`, 'm').test(src);
      if (importedFromLocalModule || locallyDefinedFunction) bad.add(name);
    }
  }
  if (bad.size) {
    problems += bad.size;
    console.log(`UNSAFE ${rel}  -> ${[...bad].join(', ')}`);
    console.log(
      '        either inline the body into the worklet, or move it into this file with a ' +
        "'worklet' directive"
    );
  } else {
    console.log(`ok     ${rel}  (worklets=${worklets.length})`);
  }
}

console.log(
  problems === 0
    ? 'CLEAN: no worklet calls a function it cannot reach on the UI runtime'
    : `${problems} unsafe capture(s)`
);
process.exit(problems === 0 ? 0 : 1);
