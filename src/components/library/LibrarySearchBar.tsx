// src/components/library/LibrarySearchBar.tsx
import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Platform,
  Keyboard,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import { Search, X, Clock, ArrowUpDown, SlidersHorizontal, Check, ChevronDown } from 'lucide-react-native';

import { KeyboardHelper } from '../../../modules/audio-hardware-router/src';

import { LIBRARY_FILTERS } from '../../services/search/useLibrarySearch';
import { LibraryFilter } from '../../services/search/librarySearch';
import { SortOption } from './LibrarySortModal';

interface LibrarySearchBarProps {
  text: string;
  pending: boolean;
  tokens: string[];
  filter: LibraryFilter;
  recents: string[];
  resultCount: number;
  totalCount: number;
  sortOption: SortOption;
  onChangeText: (value: string) => void;
  onCommit: () => void;
  onClear: () => void;
  onRemoveToken: (token: string) => void;
  onPickRecent: (value: string) => void;
  onRemoveRecent: (value: string) => void;
  onFilterChange: (next: LibraryFilter) => void;
  onPressSort: () => void;
  /** Lets the screen track focus (the hardware back key steps out of it). */
  onFocusChange?: (focused: boolean) => void;
  /** Android back press while the field owns the keyboard. */
  onExit: () => void;
  /** Hide the whole strip (keeps the query, so results stay filtered). */
  onHide: () => void;
  inputRef?: React.RefObject<TextInput | null>;
}

const ease = Easing.out(Easing.cubic);

/**
 * The library's search surface: a persistent field (no "tap an icon to
 * discover the feature"), live token chips so you can see and remove what you
 * actually searched for, time/length filters, recent queries, and a result
 * count that also acts as the "back to everything" control.
 */
export const LibrarySearchBar: React.FC<LibrarySearchBarProps> = ({
  text,
  pending,
  tokens,
  filter,
  recents,
  resultCount,
  totalCount,
  sortOption,
  onChangeText,
  onCommit,
  onClear,
  onRemoveToken,
  onPickRecent,
  onRemoveRecent,
  onFilterChange,
  onPressSort,
  onExit,
  onHide,
  onFocusChange,
  inputRef,
}) => {
  const ownRef = useRef<TextInput | null>(null);
  const ref = inputRef ?? ownRef;
  const [focused, setFocused] = useState(false);
  const ring = useSharedValue(0);

  const setFocusAnim = useCallback(
    (on: boolean) => {
      ring.value = withTiming(on ? 1 : 0, { duration: 180, easing: ease });
    },
    [ring]
  );

  const ringStyle = useAnimatedStyle(() => ({
    opacity: ring.value,
    borderColor: `rgba(255, 255, 255, ${0.10 + 0.32 * ring.value})`,
    backgroundColor: ring.value > 0.5 ? '#141417' : '#101013',
  }));

  const active = text.trim().length > 0 || filter !== 'all';

  const handleKeyPress = useCallback(
    (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      // Backspace on an empty field steps back out of the search: first the
      // last token, then the filter chip, then the keyboard.
      if (e.nativeEvent.key !== 'Backspace') return;
      if (text.length > 0) return;
      if (tokens.length > 0) {
        onRemoveToken(tokens[tokens.length - 1]);
        return;
      }
      if (filter !== 'all') {
        onFilterChange('all');
        return;
      }
      // Nothing left to undo. With the keyboard up, Backspace releases it; with
      // the field already unfocused it hides the strip - search always has a way
      // out that is not "quit the app".
      if (focused) {
        onExit();
        return;
      }
      onHide();
    },
    [text, tokens, filter, focused, onRemoveToken, onFilterChange, onExit, onHide]
  );

  const applyToken = useCallback(
    (token: string) => {
      const next = text.replace(new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), ' ').trim();
      onChangeText(next ? `${next} ` : '');
    },
    [onChangeText, text]
  );

  return (
    <View style={styles.wrap}>
      <Animated.View style={[styles.fieldRow, ringStyle]}>
        <Search size={16} color={active || focused ? '#FFFFFF' : '#8E8E93'} />
        <TextInput
          ref={ref}
          style={styles.input}
          value={text}
          onChangeText={onChangeText}
          onKeyPress={handleKeyPress}
          placeholder="Search name, date, length, format"
          placeholderTextColor="#6E6E76"
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          returnKeyType="search"
          clearButtonMode="never"
          maxLength={120}
          cursorColor="#FFFFFF"
          selectionColor="rgba(255,255,255,0.35)"
          textAlignVertical="center"
          showSoftInputOnFocus={Platform.OS !== 'web'}
          onFocus={() => {
            setFocused(true);
            setFocusAnim(true);
            onFocusChange?.(true);
            // Edge-to-edge + adjustResize: ask explicitly, because a tap on a
            // field that is already focused does not always re-open the IME.
            KeyboardHelper.show().catch(() => {});
          }}
          onBlur={() => {
            setFocused(false);
            setFocusAnim(false);
            onFocusChange?.(false);
            onCommit();
          }}
          onSubmitEditing={() => {
            onCommit();
            try {
              ref.current?.blur();
            } catch {}
          }}
          accessibilityLabel="Search recordings"
          accessibilityRole="search"
        />
        {pending ? <View style={styles.typingDot} /> : null}
        <TouchableOpacity
          onPress={onHide}
          style={styles.iconBtn}
          hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
          accessibilityLabel="Hide search"
          accessibilityRole="button"
        >
          <ChevronDown size={17} color="#8E8E93" strokeWidth={2.2} />
        </TouchableOpacity>
        {text.length > 0 ? (
          <TouchableOpacity
            onPress={() => {
              onClear();
              try {
                ref.current?.focus();
              } catch {}
            }}
            style={styles.iconBtn}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            accessibilityLabel="Clear search"
          >
            <X size={15} color="#C7C7CE" strokeWidth={2.4} />
          </TouchableOpacity>
        ) : null}
        {recents.length > 0 && text.length === 0 ? (
          <View pointerEvents="none" style={styles.recentHint}>
            <Clock size={11} color="#4B4B52" />
          </View>
        ) : null}
      </Animated.View>

      {focused && text.length === 0 && recents.length > 0 ? (
        <Animated.View entering={FadeIn.duration(140)} style={styles.recentsRow}>
          <Text style={styles.recentsLabel}>RECENT</Text>
          {recents.map((r) => (
            <View key={r} style={styles.recentChip}>
              <TouchableOpacity onPress={() => onPickRecent(r)} style={styles.recentChipTouch}>
                <Text style={styles.recentChipText} numberOfLines={1}>
                  {r}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onRemoveRecent(r)}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                accessibilityLabel={`Remove ${r} from recent searches`}
              >
                <X size={11} color="#6E6E76" strokeWidth={2.6} />
              </TouchableOpacity>
            </View>
          ))}
        </Animated.View>
      ) : null}

      <View style={styles.chipsRow}>
        <ScrollViewish>
          {tokens.map((t) => (
            <TouchableOpacity
              key={t}
              style={styles.tokenChip}
              onPress={() => applyToken(t)}
              activeOpacity={0.75}
              accessibilityLabel={`Remove search term ${t}`}
            >
              <Text style={styles.tokenText}>{t}</Text>
              <X size={10} color="#000000" strokeWidth={3} />
            </TouchableOpacity>
          ))}

          {LIBRARY_FILTERS.map((f) => {
            const on = filter === f.id;
            return (
              <TouchableOpacity
                key={f.id}
                style={[styles.chip, on && styles.chipOn]}
                onPress={() => onFilterChange(on ? 'all' : f.id)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                {on ? <Check size={10} color="#000000" strokeWidth={3.4} /> : null}
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}

          <TouchableOpacity
            style={[styles.chip, styles.sortChip]}
            onPress={onPressSort}
            activeOpacity={0.75}
            accessibilityLabel={`Sort: ${sortOption}`}
          >
            {sortOption === 'date_desc' ? (
              <ArrowUpDown size={10} color="#A1A1AA" />
            ) : (
              <SlidersHorizontal size={10} color="#A1A1AA" />
            )}
            <Text style={styles.chipText}>{sortLabel(sortOption)}</Text>
          </TouchableOpacity>
        </ScrollViewish>

        <TouchableOpacity
          style={styles.countBtn}
          onPress={active ? onClear : undefined}
          disabled={!active}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text style={styles.countText}>
            {resultCount === totalCount
              ? `${totalCount} take${totalCount === 1 ? '' : 's'}`
              : `${resultCount} of ${totalCount}`}
          </Text>
          {active ? <Text style={styles.countReset}>Reset</Text> : null}
        </TouchableOpacity>
      </View>
    </View>
  );
};

const SORT_LABELS: Record<SortOption, string> = {
  date_desc: 'Newest',
  date_asc: 'Oldest',
  name_asc: 'A–Z',
  name_desc: 'Z–A',
  duration_desc: 'Longest',
  duration_asc: 'Shortest',
};

const sortLabel = (option: SortOption) => SORT_LABELS[option] ?? 'Sort';

/** Chips scroll sideways on narrow phones; a plain row otherwise. */
const ScrollViewish: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <View style={styles.chipGroup}>{children}</View>
);

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 8,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingHorizontal: 11,
    gap: 9,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    color: '#FFFFFF',
    fontSize: 15,
    padding: 0,
  },
  iconBtn: { padding: 4 },
  typingDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#FFFFFF',
  },
  recentHint: { position: 'absolute', right: 12 },
  recentsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  recentsLabel: {
    color: '#4B4B52',
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 0.7,
    marginRight: 2,
  },
  recentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 26,
    paddingHorizontal: 9,
    borderRadius: 13,
    backgroundColor: '#121215',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  recentChipTouch: { maxWidth: 150 },
  recentChipText: { color: '#C7C7CE', fontSize: 12, fontWeight: '500' },
  chipsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  chipGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    flexShrink: 1,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 26,
    paddingHorizontal: 9,
    borderRadius: 13,
    backgroundColor: '#101013',
    borderWidth: 1,
    borderColor: '#1F1F26',
  },
  chipOn: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  chipText: { color: '#8E8E93', fontSize: 11.5, fontWeight: '600' },
  chipTextOn: { color: '#000000', fontWeight: '800', marginLeft: 2 },
  sortChip: { marginLeft: 2 },
  tokenChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 26,
    paddingHorizontal: 9,
    borderRadius: 13,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#FFFFFF',
  },
  tokenText: { color: '#000000', fontSize: 11.5, fontWeight: '800' },
  countBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 6,
    flexShrink: 0,
  },
  countText: { color: '#71717A', fontSize: 11, fontWeight: '600' },
  countReset: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
});

export default LibrarySearchBar;
