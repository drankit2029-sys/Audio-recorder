// src/components/library/LibraryBatchBar.tsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Trash2, Share2 } from 'lucide-react-native';

interface LibraryBatchBarProps {
  selectedCount: number;
  totalCount: number;
  bottomOffset: number;
  onDelete: () => void;
  onExport: () => void;
}

export const LibraryBatchBar: React.FC<LibraryBatchBarProps> = ({
  selectedCount,
  totalCount,
  bottomOffset,
  onDelete,
  onExport,
}) => {
  const isSelectionEmpty = selectedCount === 0;
  const isAllSelected = totalCount > 0 && selectedCount === totalCount;

  return (
    <View style={[styles.floatingSplitDeck, { bottom: bottomOffset }]} pointerEvents="box-none">
      <View style={styles.floatingSplitBezel}>
        <TouchableOpacity
          style={[
            styles.splitHalfBtn,
            styles.splitLeftBtn,
            isSelectionEmpty && styles.splitBtnDisabled,
          ]}
          disabled={isSelectionEmpty}
          onPress={onDelete}
          activeOpacity={0.75}
        >
          <View
            style={[
              styles.floatingIconCircleDelete,
              isSelectionEmpty && styles.floatingIconCircleDisabled,
            ]}
          >
            <Trash2
              size={15}
              color={isSelectionEmpty ? '#5A2624' : '#FF453A'}
              strokeWidth={2.2}
            />
          </View>
          <Text
            style={[
              styles.splitDeleteText,
              isSelectionEmpty && styles.splitDeleteTextDisabled,
            ]}
          >
            {isAllSelected
              ? 'Delete all'
              : selectedCount > 0
              ? `Delete (${selectedCount})`
              : 'Delete all'}
          </Text>
        </TouchableOpacity>

        <View style={styles.splitDivider} />

        <TouchableOpacity
          style={[
            styles.splitHalfBtn,
            styles.splitRightBtn,
            isSelectionEmpty && styles.splitBtnDisabled,
          ]}
          disabled={isSelectionEmpty}
          onPress={onExport}
          activeOpacity={0.75}
        >
          <View
            style={[
              styles.floatingIconCircleExport,
              isSelectionEmpty && styles.floatingIconCircleDisabled,
            ]}
          >
            <Share2
              size={15}
              color={isSelectionEmpty ? '#52525B' : '#FFFFFF'}
              strokeWidth={2.2}
            />
          </View>
          <Text
            style={[
              styles.splitExportText,
              isSelectionEmpty && styles.splitExportTextDisabled,
            ]}
          >
            {isAllSelected
              ? 'Export all'
              : selectedCount > 0
              ? `Export (${selectedCount})`
              : 'Export all'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  floatingSplitDeck: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 9999,
    elevation: 99,
  },
  floatingSplitBezel: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#141416',
    borderWidth: 1.5,
    borderColor: '#26262C',
    borderRadius: 28,
    paddingVertical: 6,
    paddingHorizontal: 10,
    maxWidth: 360,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 14,
  },
  splitHalfBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  splitLeftBtn: {
    paddingLeft: 10,
  },
  splitRightBtn: {
    paddingRight: 10,
  },
  splitBtnDisabled: {
    opacity: 0.4,
  },
  floatingIconCircleDelete: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#261414',
    borderWidth: 1,
    borderColor: '#3D1C1C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatingIconCircleExport: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#222228',
    borderWidth: 1,
    borderColor: '#2F2F38',
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatingIconCircleDisabled: {
    backgroundColor: '#161618',
    borderColor: '#222226',
  },
  splitDeleteText: {
    color: '#FF453A',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  splitDeleteTextDisabled: {
    color: '#5A2624',
  },
  splitDivider: {
    width: 1,
    height: 22,
    backgroundColor: '#26262E',
    marginHorizontal: 4,
  },
  splitExportText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  splitExportTextDisabled: {
    color: '#52525B',
  },
});