// src/services/storage/prompterStorage.ts
import { createMMKV } from 'react-native-mmkv';

const prompterStorage = createMMKV({
  id: 'audio-prompter-storage',
});

const SCRIPT_KEY = 'prompter_script_text';
const SPEED_KEY = 'prompter_scroll_speed_px';
const FONT_SIZE_KEY = 'prompter_font_size';
const MIRROR_KEY = 'prompter_is_mirrored';

const DEFAULT_SCRIPT = `Welcome to the studio. This is your synchronized teleprompter.

Speak with a steady, natural cadence and maintain consistent distance from the microphone capsule.

Watch the real-time Skia meter below to protect your dynamic range. Target your speech peaks between -18 dBFS and -6 dBFS for broadcast-ready master audio.

Use the Mirror toggle if you are shooting through a beam-splitter glass rig, or adjust the speed stepper above to match your reading tempo.`;

export const PrompterStorage = {
  getScript(): string {
    const val = prompterStorage.getString(SCRIPT_KEY);
    return val && val.trim().length > 0 ? val : DEFAULT_SCRIPT;
  },

  setScript(text: string): void {
    const clean = text && text.trim().length > 0 ? text.trim() : DEFAULT_SCRIPT;
    prompterStorage.set(SCRIPT_KEY, clean);
  },

  getSpeed(): number {
    const val = prompterStorage.getNumber(SPEED_KEY);
    return typeof val === 'number' && !isNaN(val) && val >= 0 && val <= 200 ? val : 35;
  },

  setSpeed(speed: number): void {
    const clamped = Math.max(0, Math.min(200, speed));
    prompterStorage.set(SPEED_KEY, clamped);
  },

  getFontSize(): number {
    const val = prompterStorage.getNumber(FONT_SIZE_KEY);
    return typeof val === 'number' && !isNaN(val) && val >= 1 && val <= 50 ? val : 20;
  },

  setFontSize(size: number): void {
    const clamped = Math.max(1, Math.min(50, size));
    prompterStorage.set(FONT_SIZE_KEY, clamped);
  },

  getIsMirrored(): boolean {
    return prompterStorage.getBoolean(MIRROR_KEY) ?? false;
  },

  setIsMirrored(mirrored: boolean): void {
    prompterStorage.set(MIRROR_KEY, mirrored);
  },
};