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
