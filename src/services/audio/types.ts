// src/services/audio/types.ts
import { RecordingOptions } from 'expo-audio';
import { AudioInputDevice } from '../../../modules/audio-hardware-router/src';

export type PresetKey = string;

export type AudioFormatType =
  | 'wav'
  | 'aac'
  | 'opus'
  | 'flac'
  | 'amr_wb'
  | 'amr_nb';

export interface CustomPresetConfig {
  id: string;
  name: string;
  format: AudioFormatType;
  sampleRate: number; // Arbitrary Hz (e.g., 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 192000)
  channels: number;   // 1 (Mono), 2 (Stereo), 4 (Multi-ch)
  bitDepth?: number;  // 8, 16, 24, 32
  bitRate?: number;   // 32000 to 512000 bps
  description?: string;
  createdAt: number;
}

export interface AudioPresetConfig {
  key: string;
  label: string;
  badge: string;
  description: string;
  format: AudioFormatType;
  extension: '.wav' | '.m4a' | '.ogg' | '.flac' | '.3gp';
  mimeType: string;
  sampleRate: number;
  channels: number;
  bitDepth?: number;
  bitRate?: number;
  isCustom?: boolean;
  options: RecordingOptions;
}

export interface DeviceCompatibilityResult {
  isSupported: boolean;
  reasons: string[];
}

export function checkDeviceCompatibility(
  preset: AudioPresetConfig,
  device: AudioInputDevice | null
): DeviceCompatibilityResult {
  if (!device) return { isSupported: true, reasons: [] };

  const reasons: string[] = [];
  const isUsb =
    device.type === 'usb_device' ||
    device.type === 'usb_headset' ||
    device.type === 'usb_accessory';

  // 1. Android Codec-Specific Hard Limits
  if (preset.format === 'amr_nb') {
    if (preset.sampleRate !== 8000 || preset.channels !== 1) {
      reasons.push('AMR-NB codec is hard-limited to 8.0 kHz Mono voice telephony.');
    }
  } else if (preset.format === 'amr_wb') {
    if (preset.sampleRate !== 16000 || preset.channels !== 1) {
      reasons.push('AMR-WB codec is hard-limited to 16.0 kHz Mono voice telephony.');
    }
  }

  // 2. Hardware Channel Capabilities
  if (device.channelCounts && device.channelCounts.length > 0) {
    if (!device.channelCounts.includes(preset.channels)) {
      const supStr = device.channelCounts
        .map((c) => (c === 1 ? 'Mono' : c === 2 ? 'Stereo' : `${c}Ch`))
        .join(', ');
      const reqStr = preset.channels === 1 ? 'Mono' : preset.channels === 2 ? 'Stereo' : `${preset.channels}-Ch`;
      reasons.push(
        `Selected capsule ("${device.name}") does not support ${reqStr} capture (Capsule supports: ${supStr}).`
      );
    }
  }

  // 3. Hardware Sample Rate Clocking
  if (device.sampleRates && device.sampleRates.length > 0) {
    if (!device.sampleRates.includes(preset.sampleRate)) {
      if (preset.sampleRate > 48000 && !isUsb) {
        reasons.push(
          `High-res rate ${(preset.sampleRate / 1000).toFixed(1)} kHz requires an external USB Audio Interface. "${device.name}" DAC clock caps at 48.0 kHz.`
        );
      } else {
        const supRates = device.sampleRates
          .map((r) => `${(r / 1000).toFixed(1)}k`)
          .join(', ');
        reasons.push(
          `Capsule clock on "${device.name}" does not report native support for ${(preset.sampleRate / 1000).toFixed(1)} kHz (Hardware reports: ${supRates}).`
        );
      }
    }
  } else if (preset.sampleRate > 48000 && !isUsb) {
    reasons.push(
      `High-res ${(preset.sampleRate / 1000).toFixed(1)} kHz studio capture requires an external USB audio interface.`
    );
  }

  // 4. PCM Bit Depth Verification
  if (preset.bitDepth && preset.bitDepth > 16 && !isUsb) {
    reasons.push(
      `PCM Bit Depth of ${preset.bitDepth}-bit requires an external USB Audio Interface. Built-in Android HAL caps input at 16-bit integer PCM.`
    );
  }

  return {
    isSupported: reasons.length === 0,
    reasons,
  };
}

export function customPresetToAudioPreset(custom: CustomPresetConfig): AudioPresetConfig {
  const isWav = custom.format === 'wav';
  const isFlac = custom.format === 'flac';
  const isCompressed = !isWav && !isFlac;

  const rateKhz = (custom.sampleRate / 1000).toFixed(1);
  const chLabel = custom.channels === 1 ? 'Mono' : custom.channels === 2 ? 'Stereo' : `${custom.channels}Ch`;
  const depthOrRate = isCompressed
    ? `${Math.round((custom.bitRate ?? 256000) / 1000)}kbps`
    : `${custom.bitDepth ?? 16}-bit`;

  const formatLabels: Record<AudioFormatType, string> = {
    wav: 'WAV',
    aac: 'AAC',
    opus: 'OPUS',
    flac: 'FLAC',
    amr_wb: 'AMR-WB',
    amr_nb: 'AMR-NB',
  };

  const badge = `${formatLabels[custom.format]} ${rateKhz}kHz ${depthOrRate} ${chLabel}`;

  let extension: '.wav' | '.m4a' | '.ogg' | '.flac' | '.3gp' = '.wav';
  let mimeType = 'audio/wav';

  switch (custom.format) {
    case 'wav':
      extension = '.wav';
      mimeType = 'audio/wav';
      break;
    case 'aac':
      extension = '.m4a';
      mimeType = 'audio/mp4a-latm';
      break;
    case 'opus':
      extension = '.ogg';
      mimeType = 'audio/ogg';
      break;
    case 'flac':
      extension = '.flac';
      mimeType = 'audio/flac';
      break;
    case 'amr_wb':
      extension = '.3gp';
      mimeType = 'audio/amr-wb';
      break;
    case 'amr_nb':
      extension = '.3gp';
      mimeType = 'audio/3gpp';
      break;
  }

  const options: RecordingOptions = {
    extension,
    sampleRate: custom.sampleRate,
    numberOfChannels: custom.channels,
    bitDepth: custom.bitDepth,
    bitRate: custom.bitRate,
    isMeteringEnabled: true,
    android: {
      extension,
      bitRate: custom.bitRate,
      isMeteringEnabled: true,
    },
  };

  return {
    key: custom.id,
    label: custom.name,
    badge,
    description:
      custom.description ||
      `Custom ${formatLabels[custom.format]} configuration: ${rateKhz} kHz, ${depthOrRate}, ${chLabel}.`,
    format: custom.format,
    extension,
    mimeType,
    sampleRate: custom.sampleRate,
    channels: custom.channels,
    bitDepth: !isCompressed ? custom.bitDepth ?? 16 : undefined,
    bitRate: isCompressed ? custom.bitRate ?? 256000 : undefined,
    isCustom: true,
    options,
  };
}

export const AUDIO_PRESETS: Record<string, AudioPresetConfig> = {
  broadcast_wav_48k: {
    key: 'broadcast_wav_48k',
    label: 'Broadcast Master',
    badge: 'WAV 48kHz 16-bit Mono',
    description: 'Uncompressed PCM Mono. Industry standard for studio recording, film, and post-production mastering.',
    format: 'wav',
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
        isMeteringEnabled: true,
      },
    },
  },
  podcast_wav_44k: {
    key: 'podcast_wav_44k',
    label: 'Standard Podcast',
    badge: 'WAV 44.1kHz 16-bit Mono',
    description: 'Uncompressed CD-quality Mono. Optimized for spoken word, narrative podcasts, and speech synthesis.',
    format: 'wav',
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
        isMeteringEnabled: true,
      },
    },
  },
  share_aac_48k: {
    key: 'share_aac_48k',
    label: 'Lightweight Proxy',
    badge: 'AAC 256kbps 48kHz Mono',
    description: 'VBR MPEG-4 AAC. Compact file size for messaging apps, quick email previews, and scratch tracks.',
    format: 'aac',
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
        bitRate: 256000,
        isMeteringEnabled: true,
      },
    },
  },
};