// src/components/library/LibrarySortModal.tsx
import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { X, Check } from 'lucide-react-native';
import { useResponsive } from '../../hooks/useResponsive';

export type SortOption =
  | 'name_asc'
  | 'name_desc'
  | 'duration_asc'
  | 'duration_desc'
  | 'date_desc'
  | 'date_asc';

export const SORT_LABELS: Record<SortOption, string> = {
  date_desc: 'Date created (Latest to oldest)',
  date_asc: 'Date created (Oldest to latest)',
  name_asc: 'Name (A to Z)',
  name_desc: 'Name (Z to A)',
  duration_asc: 'Length (Short to long)',
  duration_desc: 'Length (Long to short)',
};

interface LibrarySortModalProps {
  visible: boolean;
  activeSort: SortOption;
  onSelectSort: (option: SortOption) => void;
  onClose: () => void;
}

export const LibrarySortModal: React.FC<LibrarySortModalProps> = ({
  visible,
  activeSort,
  onSelectSort,
  onClose,
}) => {
  const { isTablet } = useResponsive();

  return (
    <Modal
      visible={visible}
      transparent
      animationType={isTablet ? 'fade' : 'slide'}
      onRequestClose={onClose}
    >
      <View style={styles.sortBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sortCard, isTablet && styles.sortCardTablet]}>
          <View style={styles.sortHeader}>
            <Text style={styles.sortHeading}>Sort by</Text>
            <TouchableOpacity onPress={onClose} style={styles.sortCloseBtn}>
              <X size={16} color="#FFFFFF" />
            </TouchableOpacity>
          </View>

          {(Object.keys(SORT_LABELS) as SortOption[]).map((key) => {
            const isSelected = activeSort === key;
            return (
              <TouchableOpacity
                key={key}
                style={styles.sortOptionRow}
                onPress={() => onSelectSort(key)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.sortOptionText,
                    isSelected && styles.sortOptionTextSelected,
                  ]}
                >
                  {SORT_LABELS[key]}
                </Text>
                {isSelected && <Check size={16} color="#FFFFFF" />}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  sortBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  sortCard: {
    backgroundColor: '#141414',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: '#262626',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 36,
    gap: 4,
  },
  sortCardTablet: {
    alignSelf: 'center',
    width: 480,
    borderRadius: 24,
    marginBottom: 60,
  },
  sortHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222222',
    marginBottom: 8,
  },
  sortHeading: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  sortCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#202020',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sortOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  sortOptionText: {
    color: '#8E8E93',
    fontSize: 15,
    fontWeight: '500',
  },
  sortOptionTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
});