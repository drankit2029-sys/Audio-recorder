import { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';

export interface KeyboardViewport {
  /** Raw height reported by the OS. */
  rawHeight: number;
  /**
   * Height the UI must reserve at the bottom edge.
   * 0 when the OS already shrank the window (Android adjustResize),
   * otherwise the full keyboard height to prevent control clipping.
   */
  offset: number;
  isVisible: boolean;
}

const SHOW_EVENT = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
const HIDE_EVENT = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

export function useKeyboardViewport(): KeyboardViewport {
  const { height } = useWindowDimensions();
  const heightRef = useRef(height);
  heightRef.current = height;

  const fullHeightRef = useRef(height);
  const [rawHeight, setRawHeight] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener(SHOW_EVENT, (e) => {
      setRawHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(HIDE_EVENT, () => setRawHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (rawHeight === 0) fullHeightRef.current = height;
  }, [rawHeight, height]);

  const windowShrink = Math.max(0, fullHeightRef.current - heightRef.current);
  const offset = Math.max(0, rawHeight - windowShrink);

  return { rawHeight, offset, isVisible: rawHeight > 0 };
}
