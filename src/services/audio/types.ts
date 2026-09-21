// src/services/audio/types.ts
import { RecordingOptions } from 'expo-audio';

export type PresetKey = 'broadcast_wav_48k' | 'podcast_wav_44k' | 'share_aac_48k';

export interface AudioPresetConfig {
  key: PresetKey;
  label: string;
  badge: string;
  description: string;
  extension: '.wav' | '.m4a';
  mimeType: string;
  sampleRate: number;
  channels: 1 | 2;
  bitDepth?: 16 | 24;
  bitRate?: number;
  options: RecordingOptions;
}

export const AUDIO_PRESETS: Record<PresetKey, AudioPresetConfig> = {
  broadcast_wav_48k: {
    key: 'broadcast_wav_48k',
    label: 'Broadcast Master',
    badge: 'WAV 48kHz 16-bit',
    description: 'Uncompressed PCM Mono. Industry standard for studio recording, film, and post-production mastering.',
    extension: '.wav',
    mimeType: 'audio/wav',
    sampleRate: 48000,
    channels: 1,
    bitDepth: 16,
    options: {
      extension: '.wav',
      sampleRate: 48000,
      numberOfChannels: 1,
      bitDepth: 16,
      isMeteringEnabled: true,
      android: {
        extension: '.wav',
        outputFormat: 'default',
        audioEncoder: 'default',
        isMeteringEnabled: true,
      },
      ios: {
        extension: '.wav',
        audioQuality: 127,
        sampleRate: 48000,
        numberOfChannels: 1,
        bitDepth: 16,
        linearPCM: true,
        isMeteringEnabled: true,
      },
    },
  },
  podcast_wav_44k: {
    key: 'podcast_wav_44k',
    label: 'Standard Podcast',
    badge: 'WAV 44.1kHz 16-bit',
    description: 'Uncompressed CD-quality Mono. Optimized for spoken word, narrative podcasts, and speech synthesis.',
    extension: '.wav',
    mimeType: 'audio/wav',
    sampleRate: 44100,
    channels: 1,
    bitDepth: 16,
    options: {
      extension: '.wav',
      sampleRate: 44100,
      numberOfChannels: 1,
      bitDepth: 16,
      isMeteringEnabled: true,
      android: {
        extension: '.wav',
        outputFormat: 'default',
        audioEncoder: 'default',
        isMeteringEnabled: true,
      },
      ios: {
        extension: '.wav',
        audioQuality: 127,
        sampleRate: 44100,
        numberOfChannels: 1,
        bitDepth: 16,
        linearPCM: true,
        isMeteringEnabled: true,
      },
    },
  },
  share_aac_48k: {
    key: 'share_aac_48k',
    label: 'Lightweight Proxy',
    badge: 'AAC 256kbps 48kHz',
    description: 'VBR MPEG-4 AAC. Compact file size for messaging apps, quick email previews, and scratch tracks.',
    extension: '.m4a',
    mimeType: 'audio/mp4a-latm',
    sampleRate: 48000,
    channels: 1,
    bitRate: 256000,
    options: {
      extension: '.m4a',
      sampleRate: 48000,
      numberOfChannels: 1,
      bitRate: 256000,
      isMeteringEnabled: true,
      android: {
        extension: '.m4a',
        outputFormat: 'mpeg4',
        audioEncoder: 'aac',
        bitRate: 256000,
        isMeteringEnabled: true,
      },
      ios: {
        extension: '.m4a',
        audioQuality: 127,
        sampleRate: 48000,
        numberOfChannels: 1,
        bitRate: 256000,
        isMeteringEnabled: true,
      },
    },
  },
};