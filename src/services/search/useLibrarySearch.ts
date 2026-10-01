// src/services/search/useLibrarySearch.ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createMMKV } from 'react-native-mmkv';
import { SavedRecording } from '../storage/recordingLibrary';
import {
  HighlightRange,
  LibraryFilter,
  LibrarySearchHit,
  LibrarySearchResult,
  searchLibrary,
  tokenize,
} from './librarySearch';

const store = createMMKV({ id: 'library-search' });
const RECENT_KEY = 'recent_queries_v1';
const FILTER_KEY = 'filter_v1';
/** Whether the search strip is shown at all - remembered across launches. */
const OPEN_KEY = 'strip_open_v1';
const MAX_RECENT = 6;
/**
 * A keystroke must not re-filter a big library on the same frame — the input
 * would start to feel sticky. 90 ms is below the "typing rhythm" threshold and
 * still feels instant.
 */
const DEBOUNCE_MS = 90;

const readRecents = (): string[] => {
  try {
    const raw = store.getString(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
};

const readFilter = (): LibraryFilter => {
  try {
    const raw = store.getString(FILTER_KEY);
    if (
      raw === 'all' ||
      raw === 'today' ||
      raw === 'week' ||
      raw === 'month' ||
      raw === 'long' ||
      raw === 'short'
    ) {
      return raw;
    }
  } catch {}
  return 'all';
};

export interface LibrarySearch {
  /** Live text in the field (never delayed: the input is uncontrolled-ish). */
  text: string;
  setText: (value: string) => void;
  /** Debounced text the list is actually filtered by. */
  query: string;
  filter: LibraryFilter;
  setFilter: (next: LibraryFilter) => void;
  recents: string[];
  /** Is the search strip on screen? Toggling it is persisted. */
  visible: boolean;
  setVisible: (next: boolean) => void;
  collapse: () => void;
  commit: () => void;
  clear: () => void;
  removeRecent: (value: string) => void;
  /** How long results lag the keystrokes (used for the subtle "typing" cue). */
  pending: boolean;
  results: LibrarySearchResult;
  items: SavedRecording[];
  /** id -> highlight ranges, for the cards. */
  highlights: Map<string, HighlightRange[]>;
  tokens: string[];
}

export function useLibrarySearch(recordings: SavedRecording[]): LibrarySearch {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilterState] = useState<LibraryFilter>(readFilter);
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [visible, setVisibleState] = useState<boolean>(() => {
    try {
      return store.getBoolean(OPEN_KEY) !== false;
    } catch {
      return true;
    }
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Show/hide the whole search strip. Collapsing keeps the query and the filter
   * (so the list stays filtered and the header dot stays lit) - clearing is a
   * separate, explicit action.
   */
  const setVisible = useCallback((next: boolean) => {
    setVisibleState(next);
    try {
      store.set(OPEN_KEY, next);
    } catch {}
  }, []);

  const pushDebounced = useCallback((value: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setQuery(value);
    }, DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      setText(value);
      pushDebounced(value);
    },
    [pushDebounced]
  );

  const persist = useCallback((next: string[]) => {
    setRecents(next);
    try {
      store.set(RECENT_KEY, JSON.stringify(next));
    } catch {}
  }, []);

  const commit = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setQuery(text);
    const trimmed = text.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    const next = [trimmed, ...readRecents().filter((r) => r.toLowerCase() !== lower)].slice(
      0,
      MAX_RECENT
    );
    persist(next);
  }, [persist, text]);

  const collapse = useCallback(() => {
    setVisible(false);
  }, [setVisible]);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setText('');
    setQuery('');
  }, []);

  const removeRecent = useCallback(
    (value: string) => {
      persist(readRecents().filter((r) => r !== value));
    },
    [persist]
  );

  const setFilter = useCallback((next: LibraryFilter) => {
    setFilterState(next);
    try {
      store.set(FILTER_KEY, next);
    } catch {}
  }, []);

  const results = useMemo(
    () => searchLibrary(recordings, query, filter),
    [recordings, query, filter]
  );

  const items = useMemo(() => results.hits.map((h: LibrarySearchHit) => h.item), [results]);

  const highlights = useMemo(() => {
    const map = new Map<string, HighlightRange[]>();
    for (const hit of results.hits) {
      if (hit.ranges.length > 0) map.set(hit.item.id, hit.ranges);
    }
    return map;
  }, [results]);

  const tokens = useMemo(() => tokenize(query), [query]);

  return {
    text,
    setText: handleChange,
    query,
    filter,
    setFilter,
    recents,
    visible,
    setVisible,
    collapse,
    commit,
    clear,
    removeRecent,
    pending: text !== query,
    results,
    items,
    highlights,
    tokens,
  };
}

export const LIBRARY_FILTERS: { id: LibraryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'Month' },
  { id: 'long', label: '1 min +' },
  { id: 'short', label: 'Under 10s' },
];
