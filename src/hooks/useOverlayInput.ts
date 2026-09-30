// src/hooks/useOverlayInput.ts
import { RefObject, useEffect, useRef } from 'react';
import { BackHandler, Keyboard, TextInput } from 'react-native';

/**
 * Focuses the text field of an in-window dialog and makes sure the soft
 * keyboard really opens.
 *
 * The name dialogs used to be RN <Modal>s (separate Android dialog windows)
 * that focused their field on a fixed 240 ms timer. That timer could fire
 * before the dialog window was attached or had window focus, in which case
 * InputMethodManager silently ignores showSoftInput() and nothing ever
 * retried. The dialogs now live in the activity window (which already has
 * focus), use autoFocus, and this hook re-checks shortly after opening.
 */
export function useAutoFocusInput(visible: boolean, inputRef: RefObject<TextInput | null>) {
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    timers.push(
      setTimeout(() => {
        if (!cancelled && !inputRef.current?.isFocused()) inputRef.current?.focus();
      }, 80)
    );

    timers.push(
      setTimeout(() => {
        const input = inputRef.current;
        if (cancelled || !input) return;
        if (!input.isFocused()) {
          input.focus();
        } else if (!Keyboard.isVisible()) {
          // Focused without a keyboard: cycle focus so showSoftInput() runs again.
          input.blur();
          timers.push(
            setTimeout(() => {
              if (!cancelled) inputRef.current?.focus();
            }, 60)
          );
        }
      }, 650)
    );

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [visible, inputRef]);
}

/** Routes the Android back button to `handler` while `active`. */
export function useBackPress(active: boolean, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!active) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handlerRef.current();
      return true;
    });
    return () => sub.remove();
  }, [active]);
}
