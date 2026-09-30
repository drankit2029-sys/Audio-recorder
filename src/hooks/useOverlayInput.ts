// src/hooks/useOverlayInput.ts
import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

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
