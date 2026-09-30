# Bugfix Round — 2026-09-30

Fixes the five reported issues. TypeScript (`tsc --noEmit`) and the full
Metro bundle (`expo export --platform android`) both pass.

## 1. Search UI not working on clicking the search icon

**Root cause:** the search field only relied on `autoFocus` for the freshly
mounted `TextInput`. On Android 15+ (edge-to-edge, targetSdk 36) the IME is
not reliably shown for an input that gains focus during the same layout
pass, so the field appeared but could not be typed into.

**Fix (`src/screens/LibraryScreen.tsx`):**
- When the search bar opens, the input is focused explicitly with staggered
  retries (120 ms / 400 ms) and the native keyboard helper is invoked.
- The input now also carries `showSoftInputOnFocus` and calls
  `KeyboardHelper.show()` on focus.
- The native `showSoftKeyboard` helper (see #3) now actually finds the
  focused `EditText` instead of failing on a null/decor focus.

## 2. Central record button sometimes shifting to the left

**Root cause:** the main button's X offset is a spring (`slideProgress`).
Three things made it misbehave:
- on cold start a live take is re-attached and the button *slid* from centre
  to the left slot without any user action;
- the spring was slightly under-damped (overshoot);
- the spring is only re-targeted when the active state changes, so if the
  transport subtree was hidden/shown while a spring was mid-flight the
  button could settle at an intermediate offset.

**Fix (`App.tsx`):**
- The spring now *jumps* (no animation) on first paint, when the transport
  is re-shown, and during the ~1.2 s bootstrap window (cold-start
  re-attach) — the slide only plays for genuine user-initiated state
  changes.
- The spring is now slightly over-damped so it can never overshoot its
  slot.
- Both button wrappers now have an explicit shared slot
  (`top: 2, left: 72` in the 220×80 bezel), so the resting position no
  longer depends on layout-engine static-position behaviour.

## 3. Keyboard not triggering while saving and renaming

**Root cause:** both dialogs were react-native `<Modal>`s. On Android an RN
Modal is a separate window, and under edge-to-edge Android 15+ the IME is
not shown for inputs inside that window. The native `showSoftKeyboard`
helper made it worse: it only looked at `activity.getCurrentFocus()` and
otherwise fell back to the decor view (which is not an `EditText`), so
`showSoftInput` returned false.

**Fixes:**
- `SaveRecordingModal` and `RenameRecordingModal` are now **in-window
  overlays** (absolute-fill `Animated.View` with a fade, above the floating
  transport at z 10050 / elevation 101, below the BusyOverlay at z 30000).
  Same window as the activity → focus/IME behave like on any other screen.
  They stretch over the safe-area insets via negative offsets so they still
  cover the status bar and gesture area.
- Focus is requested with staggered retries (60 ms kickoff, then
  50/150/350/650/1100 ms), `showSoftInputOnFocus` is set, tapping the field
  re-requests focus + keyboard, and the input is blurred + the keyboard
  dismissed when the overlay hides.
- Native (`AudioHardwareRouterModule.showSoftKeyboard`): walks the view
  hierarchy for the focused `EditText` (then the first `EditText`), calls
  `requestFocus()` on it, then `showSoftInput` with two fallbacks
  (`showSoftInput(target, 0)`, `toggleSoftInput(SHOW_FORCED)`).
  This also improves the search field, the prompter editor and the preset
  name field.

## 4. Transition between preview / replace not smooth

**Root cause:** switching between preview and replace is a native operation
that takes a few hundred ms (stopping the AudioTrack / starting the
AudioRecord, opening the mic). While it ran, the UI playhead clock kept
extrapolating; when the engine's snapshot and meter events arrived, the
anchor was re-synced to the native start frame and the playhead visibly
jumped backwards. `preview()` also left the JS engine state stale until the
native state event round-tripped.

**Fix (`src/services/audio/useStudioSession.ts`):**
- New `isTransitioning` freeze: the playhead clock (and meter-driven
  re-anchoring) is frozen while a user-initiated record/preview switch is
  in flight — including the time `startCapture` spends acquiring audio
  routing / wake-lock (`beginSwitch()` is called before that). The playhead
  therefore holds exactly where the user tapped, then continues from there.
  A 5 s guard timer guarantees the freeze always releases.
- Snapshots that merely echo the user-initiated start (command return +
  state event for `record` / `replace` / `play`) no longer re-anchor the
  clock or yank the playhead; the command path is authoritative.
- `preview()` now applies an optimistic `previewing` snapshot so the UI
  state flips immediately instead of waiting for the native event.
- If a switch fails natively, the hook resynchronises from native state
  instead of leaving a stale engine state.
- `handleToggleReplace` no longer flips the armed flag while a
  punch-in/out is in flight (pill can no longer desync from the engine).

## 5. Expected behaviour: pause at end of preview, continue on replace

The native engine already implements both boundaries:
- playback reaching the end auto-pauses (`"ended"` → `PAUSED`),
- an overwriting pass reaching the end keeps recording
  (`"caught_up"` → continues in append mode).

The JS side now keeps the playhead continuous across both:
- on `"ended"` the playhead is exactly at the take end (the clock had been
  clamping there), the take goes to `PAUSED`, the Replace pill auto-disarms
  and the main button becomes "record" (append).
- on `"caught_up"` the playhead is kept, the duration bar only ever grows,
  the Replace pill auto-disarms, and recording continues seamlessly — no
  jump, no pause.

---

# Bugfix Round 2 — 2026-09-30

Follow-up fixes for three issues that survived Round 1. Native module
changes included — **an Android rebuild is required** (`expo run:android`),
a JS-only reload will not pick up the warm-recorder changes.

## 6. Library search input invisible (icons and count render, typing works)

**Root cause:** the search bar layout was not fully deterministic. The
container used `flex: 1` inside the (auto-height) search column and the
`TextInput` carried no explicit size or visible caret, so on Android the
input could measure to zero / render indistinguishably from the background
while the icons kept their explicit sizes. `autoFocus` on mount also raced
the first layout pass: the field could be focused before it was sized,
which is a common cause of a missing caret and "invisible" text.

**Fix (`src/screens/LibraryScreen.tsx`):**
- `searchBarContainer` now uses an explicit `width: '100%'` plus a subtle
  border, so the field is always the full bar width and visibly outlined.
- `searchInput` uses `flex: 1` + `minWidth: 0` + `height: '100%'`, so it
  fills the bar and can never collapse to zero.
- Added `cursorColor` (RN 0.86's replacement for `caretColor`) and
  `selectionColor` so the caret and selection are always visible on the
  dark background, and a brighter placeholder.
- `autoFocus` removed: the staggered retry effect (Round 1) is the single
  source of truth for focus, so the field can no longer be focused before
  it is laid out.

## 7. Silent gap at the start of a recording and after resuming from pause

**Root cause:** every start/resume called `AudioRecord` setup from scratch.
Opening/priming the input stream takes 200–500 ms on many devices during
which the engine is already "running" and the UI clock is already moving,
so the head of the segment is silent and the timer leads the audio.

**Fix:**
- `StudioEngine` (native) now keeps a **warm recorder**: when a take is
  paused, the stopped `AudioRecord` is retained instead of released, and
  the next `record()` reuses it (one fresh open if the warm instance is
  stale, e.g. the device was unplugged while paused). A stopped
  `AudioRecord` captures nothing and idles at ~zero power.
- New bridge methods `prepareRecorder(deviceId)` / `dropWarmRecorder()`:
  the studio screen pre-warms the mic whenever it is idle or paused
  (and re-warms on foreground return), and the warm mic is dropped when
  the app backgrounds (so it never blocks the microphone for other apps)
  or when the session closes/finalizes/discards.

## 8. Playhead advances then snaps back when toggling Replace / preview

**Root cause:** the Round 1 transition freeze only covered the JS→native
command window. After the command resolved, the UI clock kept running, but
the native first `AudioRecord.read()` / `AudioTrack.write()` lags the
command by 100–500 ms (device priming, blocking read). The first meter
then reported a position *behind* the UI prediction, and the 80 ms drift
gate hard re-anchored to it — the visible jump backwards.

**Fix (`src/services/audio/useStudioSession.ts`):**
- The transition freeze now stays **on until the first hardware meter for
  the target mode arrives** (`awaitingFirstMeterRef`). The playhead clock
  is frozen while the audio path primes, so the UI can never lead the
  hardware.
- That first meter re-anchors the clock to the *true* native position and
  releases the freeze; the drift gate then sees ~0 drift, so the hard
  snap-back can no longer happen after a switch.
- The wait is gated on the meter's `recording` flag (which mirrors the
  engine mode the worker ran under), so stale meters from the other mode
  that are still in flight cannot steal the anchor.
- Safety valves: a 1.5 s guard releases the freeze if no meter ever
  arrives, and any snapshot that is IDLE or not running (e.g. a
  notification paused the take) releases it immediately.
