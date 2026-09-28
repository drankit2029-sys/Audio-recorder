import {
  RecordingOptions,
  AndroidOutputFormat,
  AndroidAudioEncoder,
} from 'expo-audio';
import { AudioInputDevice } from '../../../modules/audio-hardware-router/src';

export type PresetKey = string;

export type AudioFormatType =
  | 'wav'
  | 'aac'
  | 'aac_eld'
  | 'he_aac'
  | 'aac_adts'
  | 'amr_nb'
  | 'amr_wb';

export interface CustomPresetConfig {
  id: string;
  name: string;
  format: AudioFormatType;
  sampleRate: number;
  channels: 1 | 2;
  /** Only meaningful for the AudioRecord (WAV) engine. */
  bitDepth?: 16 | 32;
  /** Only meaningful for lossy MediaRecorder formats. */
  bitRate?: number;
  description?: string;
  createdAt: number;
}

/**
 * Which native pipeline records this preset.
 *  - 'mediarecorder' : expo-audio -> android.media.MediaRecorder (lossy only)
 *  - 'audiorecord'   : local native module -> AudioRecord + RIFF writer (real WAV)
 */
export type EngineKind = 'mediarecorder' | 'audiorecord';

export interface AudioPresetConfig {
  key: string;
  label: string;
  badge: string;
  description: string;
  format: AudioFormatType;
  engine: EngineKind;
  extension: '.wav' | '.m4a' | '.aac' | '.3gp';
  mimeType: string;
  sampleRate: number;
  channels: number;
  /** Set only for the audiorecord engine. */
  bitDepth?: 16 | 32;
  /** Set only for the lossy mediarecorder engine. */
  bitRate?: number;
  isCustom?: boolean;
  /** Android output format. Required by MediaRecorder. */
  outputFormat: AndroidOutputFormat;
  /** Android audio encoder. Required by MediaRecorder. */
  audioEncoder: AndroidAudioEncoder;
  options: RecordingOptions;
}

export interface DeviceCompatibilityResult {
  isSupported: boolean;
  reasons: string[];
}

const AMBITERIOUS_RATE_LIMIT = 48000;
const VALID_AMR_NB_RATES = [8000];
const VALID_AMR_WB_RATES = [16000];

const isUsbDevice = (device: AudioInputDevice | null): boolean =>
  !!device &&
  (device.type === 'usb_device' ||
    device.type === 'usb_headset' ||
    device.type === 'usb_accessory');

const channelLabel = (n: number): string =>
  n === 1 ? 'Mono' : n === 2 ? 'Stereo' : `${n} Ch`;

export function checkDeviceCompatibility(
  preset: AudioPresetConfig,
  device: AudioInputDevice | null
): DeviceCompatibilityResult {
  if (!device) return { isSupported: true, reasons: [] };

  const reasons: string[] = [];
  const isUsb = isUsbDevice(device);
  const deviceName = device.name || 'the selected capsule';

  // ---- Codec hard limits -------------------------------------------------
  if (preset.format === 'amr_nb') {
    if (preset.sampleRate !== 8000 || preset.channels !== 1) {
      reasons.push(
        'The AMR-NB codec is hard-limited by Android to 8.0 kHz Mono telephony.'
      );
    }
  } else if (preset.format === 'amr_wb') {
    if (preset.sampleRate !== 16000 || preset.channels !== 1) {
      reasons.push(
        'The AMR-WB codec is hard-limited by Android to 16.0 kHz Mono telephony.'
      );
    }
  }

  // AAC encoders cannot do arbitrary rates either.
  if (preset.engine === 'mediarecorder' && !preset.format.startsWith('amr')) {
    if (preset.sampleRate < 8000 || preset.sampleRate > 96000) {
      reasons.push(
        `The AAC encoders supported by Android MediaRecorder accept 8-96 kHz. ${preset.sampleRate} Hz is out of range.`
      );
    }
  }

  // ---- Hardware channel capabilities -------------------------------------
  if (device.channelCounts && device.channelCounts.length > 0) {
    if (!device.channelCounts.includes(preset.channels)) {
      const sup = device.channelCounts.map(channelLabel).join(', ');
      reasons.push(
        `"${deviceName}" reports ${sup} capture only; this preset asks for ${channelLabel(preset.channels)}.`
      );
    }
  }

  // ---- Hardware sample-rate clocking -------------------------------------
  if (device.sampleRates && device.sampleRates.length > 0) {
    if (!device.sampleRates.includes(preset.sampleRate)) {
      if (preset.sampleRate > AMBITERIOUS_RATE_LIMIT && !isUsb) {
        reasons.push(
          `${(preset.sampleRate / 1000).toFixed(1)} kHz capture needs an external USB Audio Interface. The built-in capsule clock tops out at 48.0 kHz.`
        );
      } else {
        const sup = device.sampleRates
          .map((r) => `${(r / 1000).toFixed(1)}k`)
          .join(', ');
        reasons.push(
          `"${deviceName}" does not report native clocking at ${(preset.sampleRate / 1000).toFixed(1)} kHz (hardware reports: ${sup}).`
        );
      }
    }
  } else if (preset.sampleRate > AMBITERIOUS_RATE_LIMIT && !isUsb) {
    reasons.push(
      `${(preset.sampleRate / 1000).toFixed(1)} kHz capture requires an external USB Audio Interface.`
    );
  }

  // ---- Float PCM availability -------------------------------------------
  if (preset.bitDepth === 32) {
    reasons.push(
      '32-bit float PCM requires Android 8.0+ (API 26) or a class-compliant USB interface.'
    );
  }

  return { isSupported: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Factory presets
// ---------------------------------------------------------------------------

const wavEngine = (
  key: string,
  label: string,
  sampleRate: number,
  bitDepth: 16 | 32,
  description: string
): AudioPresetConfig => {
  const depth = bitDepth === 32 ? '32-bit float' : '16-bit';
  const badge = `WAV ${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)}kHz ${depth} Mono`;
  return {
    key,
    label,
    badge,
    description,
    format: 'wav',
    engine: 'audiorecord',
    extension: '.wav',
    mimeType: 'audio/wav',
    sampleRate,
    channels: 1,
    bitDepth,
    outputFormat: 'default',
    audioEncoder: 'default',
    options: {
      extension: '.wav',
      sampleRate,
      numberOfChannels: 1,
      isMeteringEnabled: true,
      android: { outputFormat: 'default', audioEncoder: 'default' },
    } as unknown as RecordingOptions,
  };
};

const aacEngine = (
  key: string,
  label: string,
  sampleRate: number,
  bitRate: number,
  audioEncoder: AndroidAudioEncoder,
  extension: '.m4a' | '.aac',
  outputFormat: AndroidOutputFormat,
  mimeType: string,
  badge: string,
  description: string
): AudioPresetConfig => ({
  key,
  label,
  badge,
  description,
  format: audioEncoder === 'he_aac' ? 'he_aac' : 'aac',
  engine: 'mediarecorder',
  extension,
  mimeType,
  sampleRate,
  channels: 1,
  bitRate,
  outputFormat,
  audioEncoder,
  options: {
    extension,
    sampleRate,
    numberOfChannels: 1,
    bitRate,
    isMeteringEnabled: true,
    directory: 'document',
    android: { outputFormat, audioEncoder },
  } as unknown as RecordingOptions,
});

const amrEngine = (
  key: string,
  label: string,
  sampleRate: number,
  audioEncoder: AndroidAudioEncoder,
  outputFormat: AndroidOutputFormat,
  bitRate: number,
  badge: string,
  description: string
): AudioPresetConfig => ({
  key,
  label,
  badge,
  description,
  format: audioEncoder === 'amr_wb' ? 'amr_wb' : 'amr_nb',
  engine: 'mediarecorder',
  extension: '.3gp',
  mimeType: 'audio/3gpp',
  sampleRate,
  channels: 1,
  bitRate,
  outputFormat,
  audioEncoder,
  options: {
    extension: '.3gp',
    sampleRate,
    numberOfChannels: 1,
    isMeteringEnabled: true,
    directory: 'document',
    android: { outputFormat, audioEncoder },
  } as unknown as RecordingOptions,
});

export const AUDIO_PRESETS: Record<string, AudioPresetConfig> = {
  broadcast_wav_48k: wavEngine(
    'broadcast_wav_48k',
    'Broadcast Master',
    48000,
    16,
    'True uncompressed RIFF/PCM written byte-for-byte by the AudioRecord pipeline. Unedited master for post-production.'
  ),
  podcast_wav_44k: wavEngine(
    'podcast_wav_44k',
    'Standard Podcast',
    44100,
    16,
    'Uncompressed CD-rate 44.1 kHz Mono PCM. Tuned for spoken word and narration.'
  ),
  share_aac_48k: aacEngine(
    'share_aac_48k',
    'Lightweight Proxy',
    48000,
    256000,
    'aac',
    '.m4a',
    'mpeg4',
    'audio/mp4',
    'AAC 256 kbps 48 kHz Mono',
    'MPEG-4 container with a real AAC encoder. Compact size for messaging, email previews and scratch tracks.'
  ),
  share_aac_adts: aacEngine(
    'share_aac_adts',
    'Raw AAC Stream',
    48000,
    192000,
    'aac',
    '.aac',
    'aac_adts',
    'audio/aac',
    'AAC-ADTS 192 kbps 48 kHz Mono',
    'Headerless-stream ADTS output for broadcast playout servers and DAWs that ingest raw AAC.'
  ),
  share_he_aac: aacEngine(
    'share_he_aac',
    'HE-AAC Compact',
    44100,
    64000,
    'he_aac',
    '.m4a',
    'mpeg4',
    'audio/mp4',
    'HE-AAC 64 kbps 44.1 kHz Mono',
    'High-Efficiency AAC. Roughly half the bitrate of AAC-LC for speech at comparable intelligibility.'
  ),
  voice_amr_nb: amrEngine(
    'voice_amr_nb',
    'Voice Telephony NB',
    8000,
    'amr_nb',
    '3gp',
    12200,
    'AMR-NB 12.2 kbps 8 kHz Mono',
    'AMR-NarrowBand in a 3GP container. 8 kHz Mono, fixed 12.2 kbps — the smallest usable voice format.'
  ),
  voice_amr_wb: amrEngine(
    'voice_amr_wb',
    'Voice Telephony WB',
    16000,
    'amr_wb',
    'amrwb',
    23850,
    'AMR-WB 23.85 kbps 16 kHz Mono',
    'AMR-WideBand in a 3GP container. 16 kHz Mono, fixed 23.85 kbps — noticeably clearer than AMR-NB.'
  ),
  master_wav_96k: wavEngine(
    'master_wav_96k',
    'High-Res Master',
    96000,
    32,
    '32-bit float PCM at 96 kHz. Requires an external USB Audio Interface — phone capsules cannot clock this high.'
  ),
};

// ---------------------------------------------------------------------------
// Custom preset mapping
// ---------------------------------------------------------------------------

export const SUPPORTED_CUSTOM_FORMATS: AudioFormatType[] = [
  'wav',
  'aac',
  'aac_adts',
  'he_aac',
  'amr_nb',
  'amr_wb',
];

const FORMAT_LABELS: Record<AudioFormatType, string> = {
  wav: 'WAV',
  aac: 'AAC',
  aac_eld: 'AAC-ELD',
  he_aac: 'HE-AAC',
  aac_adts: 'AAC-ADTS',
  amr_wb: 'AMR-WB',
  amr_nb: 'AMR-NB',
};

const ENGINE_FOR_FORMAT: Record<AudioFormatType, EngineKind> = {
  wav: 'audiorecord',
  aac: 'mediarecorder',
  aac_eld: 'mediarecorder',
  he_aac: 'mediarecorder',
  aac_adts: 'mediarecorder',
  amr_wb: 'mediarecorder',
  amr_nb: 'mediarecorder',
};

export function isFormatSupportedByAndroid(format: AudioFormatType): boolean {
  return SUPPORTED_CUSTOM_FORMATS.includes(format);
}

export function getFormatLabel(format: AudioFormatType): string {
  return FORMAT_LABELS[format] ?? format.toUpperCase();
}

export function customPresetToAudioPreset(
  custom: CustomPresetConfig
): AudioPresetConfig {
  const engine = ENGINE_FOR_FORMAT[custom.format] ?? 'mediarecorder';
  const rateKhz = (custom.sampleRate / 1000).toFixed(1);
  const chLabel = channelLabel(custom.channels);

  let extension: '.wav' | '.m4a' | '.aac' | '.3gp' = '.wav';
  let mimeType = 'audio/wav';
  let outputFormat: AndroidOutputFormat = 'default';
  let audioEncoder: AndroidAudioEncoder = 'default';
  let bitRate: number | undefined;
  let bitDepth: 16 | 32 | undefined;

  switch (custom.format) {
    case 'aac':
      extension = '.m4a';
      mimeType = 'audio/mp4';
      outputFormat = 'mpeg4';
      audioEncoder = 'aac';
      bitRate = custom.bitRate ?? 128000;
      break;
    case 'aac_eld':
      extension = '.m4a';
      mimeType = 'audio/mp4';
      outputFormat = 'mpeg4';
      audioEncoder = 'aac_eld';
      bitRate = custom.bitRate ?? 96000;
      break;
    case 'he_aac':
      extension = '.m4a';
      mimeType = 'audio/mp4';
      outputFormat = 'mpeg4';
      audioEncoder = 'he_aac';
      bitRate = custom.bitRate ?? 64000;
      break;
    case 'aac_adts':
      extension = '.aac';
      mimeType = 'audio/aac';
      outputFormat = 'aac_adts';
      audioEncoder = 'aac';
      bitRate = custom.bitRate ?? 128000;
      break;
    case 'amr_wb':
      extension = '.3gp';
      mimeType = 'audio/3gpp';
      outputFormat = 'amrwb';
      audioEncoder = 'amr_wb';
      break;
    case 'amr_nb':
      extension = '.3gp';
      mimeType = 'audio/3gpp';
      outputFormat = '3gp';
      audioEncoder = 'amr_nb';
      break;
    case 'wav':
    default:
      extension = '.wav';
      mimeType = 'audio/wav';
      outputFormat = 'default';
      audioEncoder = 'default';
      bitDepth = custom.bitDepth === 32 ? 32 : 16;
      break;
  }

  const isLossless = custom.format === 'wav';
  const depthOrRate = isLossless
    ? `${bitDepth}-bit`
    : `${Math.round((bitRate ?? 128000) / 1000)} kbps`;

  const badge = `${FORMAT_LABELS[custom.format]} ${rateKhz} kHz ${depthOrRate} ${chLabel}`;

  const options = {
    extension,
    sampleRate: custom.sampleRate,
    numberOfChannels: custom.channels,
    ...(isLossless ? {} : { bitRate }),
    isMeteringEnabled: true,
    directory: 'document' as const,
    android: { extension, outputFormat, audioEncoder },
  } as unknown as RecordingOptions;

  return {
    key: custom.id,
    label: custom.name,
    badge,
    description:
      custom.description ||
      `Custom ${FORMAT_LABELS[custom.format]} configuration: ${rateKhz} kHz, ${depthOrRate}, ${chLabel}.`,
    format: custom.format,
    engine,
    extension,
    mimeType,
    sampleRate: custom.sampleRate,
    channels: custom.channels,
    bitDepth: isLossless ? bitDepth : undefined,
    bitRate: isLossless ? undefined : bitRate,
    isCustom: true,
    outputFormat,
    audioEncoder,
    options,
  };
}

export { VALID_AMR_NB_RATES, VALID_AMR_WB_RATES };