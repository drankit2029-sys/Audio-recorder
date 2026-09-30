import * as FileSystem from 'expo-file-system/legacy';

export const TAKES_FOLDER_NAME = 'AudioRecorder';

/** Kept in sync with maxLength on the rename inputs. */
export const MAX_TAKE_NAME_LENGTH = 80;
/**
 * M6: Android file names are limited to 255 BYTES, not characters. An 80
 * character name made of emoji (4 bytes each) or Devanagari (3 bytes each)
 * overflows that and the capture fails with ENAMETOOLONG after the take has
 * already been recorded. The budget leaves room for the " (12)" collision
 * suffix and the extension.
 */
export const MAX_TAKE_NAME_BYTES = 200;

let cachedFolderUri: string | null = null;

/*
 * NOTE ON THESE PATTERNS
 * -----------------------
 * Every character class below is written with \u / \x escapes on purpose.
 * The previous version embedded a raw control byte inside the class:
 *     .replace(/[/\\?%*:|"<>\u0000-]/g, '_')
 * Hermes cannot build that class and throws at evaluation time:
 *   "Invalid regular expression: character class out of range"
 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/g;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const LEADING_JUNK = /^[.\s]+/;
const TRAILING_JUNK = /[.\s]+$/;
const WHITESPACE_RUN = /\s+/g;
const EXTENSION_TAIL = /\.[A-Za-z0-9]{1,8}$/;

export interface RelocateResult {
  uri: string | null;
  sizeBytes: number;
  /** False when the file could not be placed in the takes folder. */
  relocated: boolean;
}

/**
 * Single dedicated folder for every take, regardless of native capture engine:
 * /storage/emulated/0/Android/data/com.audiorecorder.app/files/AudioRecorder/
 */
export function getTakesFolderUri(): string {
  if (cachedFolderUri) return cachedFolderUri;

  const base = FileSystem.documentDirectory;
  if (!base) {
    throw new Error(
      'documentDirectory is unavailable. Check that expo-file-system is installed and the app has been rebuilt.'
    );
  }
  cachedFolderUri = `${base}${TAKES_FOLDER_NAME}/`;
  return cachedFolderUri;
}

export async function ensureTakesFolder(): Promise<string> {
  const uri = getTakesFolderUri();
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
    }
  } catch {
    await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
  }
  return uri;
}

/**
 * Plain filesystem path (no scheme) for the takes folder.
 *
 * Android native modules backed by java.io.File need this form. Handing them a
 * file:// URI makes java.io.File resolve it against the process CWD, producing
 * "<cwd>/file:/data/..." and failing with ENOENT.
 */
export function getTakesFolderPath(): string {
  return toNativePath(getTakesFolderUri());
}

/** Strips the file:// scheme and percent-decodes a URI into a filesystem path. */
export function toNativePath(uri: string | null | undefined): string {
  if (!uri) return '';

  let path = uri.trim();

  if (path.startsWith('content://') || path.startsWith('assets-library://')) {
    throw new Error(`Cannot use a content:// URI as a native path: ${path}`);
  }

  if (path.startsWith('file://')) {
    path = path.slice('file://'.length);
  }

  // A leftover third slash would collapse to a relative path inside java.io.File.
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Reserves a collision-free path inside the takes folder, for native writers. */
export async function reserveNativeTakePath(
  name: string,
  extension: string
): Promise<string> {
  return toNativePath(await reserveTakeFilePath(name, extension));
}

/**
 * UTF-8 length in bytes. TextEncoder is not guaranteed to exist on Hermes, so
 * this is counted directly (and counts a surrogate pair as one 4-byte scalar).
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // high surrogate: consumes the low surrogate too
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Cuts a string down to a byte budget without splitting a surrogate pair. */
function truncateToBytes(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;

  let out = '';
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    let width = 3;
    if (code < 0x80) width = 1;
    else if (code < 0x800) width = 2;
    else if (code >= 0xd800 && code <= 0xdbff) width = 4;

    if (bytes + width > maxBytes) break;
    bytes += width;
    out += width === 4 ? value.substr(i, 2) : value[i];
    if (width === 4) i += 1;
  }
  return out;
}

/** Strips characters that are illegal or hostile in Android/SAF file names. */
export function sanitizeFileName(name: string): string {
  const safe = String(name ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(ILLEGAL_NAME_CHARS, '_')
    .replace(WHITESPACE_RUN, ' ')
    .replace(LEADING_JUNK, '')
    .replace(TRAILING_JUNK, '')
    .trim();

  if (safe.length === 0) return 'Take';

  const clipped =
    safe.length > MAX_TAKE_NAME_LENGTH
      ? safe.slice(0, MAX_TAKE_NAME_LENGTH).trim()
      : safe;

  return truncateToBytes(clipped, MAX_TAKE_NAME_BYTES).trim() || 'Take';
}

export function normalizeExtension(extension: string): string {
  const raw = String(extension ?? '').trim().toLowerCase();
  if (raw.length === 0) return '';
  return raw.startsWith('.') ? raw : `.${raw}`;
}

export function buildTakeFileName(name: string, extension: string): string {
  return `${sanitizeFileName(name)}${normalizeExtension(extension)}`;
}

export async function pathExists(uri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return Boolean(info.exists);
  } catch {
    return false;
  }
}

export async function getFileSize(uri: string): Promise<number> {
  if (!uri) return 0;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && !info.isDirectory) return info.size ?? 0;
  } catch {
    /* ignore */
  }
  return 0;
}

/** "Take 1.wav" -> ".wav" */
export function extractExtension(uri: string): string {
  const clean = String(uri ?? '').split('?')[0];
  const match = EXTENSION_TAIL.exec(clean);
  return match ? match[0].toLowerCase() : '';
}

export function isInTakesFolder(uri: string | null | undefined): boolean {
  if (!uri) return false;
  try {
    return uri.startsWith(getTakesFolderUri());
  } catch {
    return false;
  }
}

/** Collision resolver: "Name.wav" -> "Name (2).wav" -> ... */
async function uniqueTarget(folder: string, stem: string, ext: string): Promise<string> {
  let candidate = `${folder}${stem}${ext}`;
  let n = 1;
  while (await pathExists(candidate)) {
    n += 1;
    if (n > 200) {
      return `${folder}${stem}-${Date.now()}${ext}`;
    }
    candidate = `${folder}${stem} (${n})${ext}`;
  }
  return candidate;
}

/** Reserves a collision-free path inside the takes folder. */
export async function reserveTakeFilePath(name: string, extension: string): Promise<string> {
  const folder = await ensureTakesFolder();
  return uniqueTarget(folder, sanitizeFileName(name), normalizeExtension(extension));
}

/** Renames an existing take so disk contents match user-edited labels. */
export async function renameTakeFile(
  uri: string,
  newName: string,
  extension?: string
): Promise<string | null> {
  if (!uri || !isInTakesFolder(uri)) return null;

  const stem = sanitizeFileName(newName);
  const ext = normalizeExtension(extension ?? '') || extractExtension(uri);
  if (!stem) return null;

  const folder = getTakesFolderUri();
  // Already named correctly: the collision check below would otherwise find
  // the file itself and rename it to "Name (2)".
  if (`${folder}${stem}${ext}` === uri) return uri;
  const target = await uniqueTarget(folder, stem, ext);
  if (target === uri) return uri;

  try {
    await FileSystem.moveAsync({ from: uri, to: target });
    return target;
  } catch {
    try {
      await FileSystem.copyAsync({ from: uri, to: target });
      await FileSystem.deleteAsync(uri, { idempotent: true });
      return target;
    } catch (copyError) {
      console.warn('[recordingPaths] Failed to rename take:', copyError);
      return null;
    }
  }
}

/** Relocates finished files with an EXDEV copy+delete fallback. */
export async function moveIntoTakesFolder(
  sourceUri: string | null | undefined,
  name: string,
  extension: string
): Promise<RelocateResult> {
  if (!sourceUri) return { uri: null, sizeBytes: 0, relocated: false };

  const sizeBytes = await getFileSize(sourceUri);
  const folder = await ensureTakesFolder();
  const ext = normalizeExtension(extension);
  const target = await uniqueTarget(folder, sanitizeFileName(name), ext);

  if (target === sourceUri) {
    return { uri: sourceUri, sizeBytes, relocated: true };
  }

  try {
    await FileSystem.moveAsync({ from: sourceUri, to: target });
    return { uri: target, sizeBytes, relocated: true };
  } catch (moveError) {
    console.warn('[recordingPaths] moveAsync failed, falling back to copy:', moveError);
  }

  try {
    await FileSystem.copyAsync({ from: sourceUri, to: target });
    await FileSystem.deleteAsync(sourceUri, { idempotent: true });
    return { uri: target, sizeBytes, relocated: true };
  } catch (copyError) {
    console.warn('[recordingPaths] Failed to relocate take:', copyError);
    return { uri: sourceUri, sizeBytes, relocated: false };
  }
}

export async function getTakesFolderDisplayPath(): Promise<string> {
  try {
    await ensureTakesFolder();
    return getTakesFolderUri();
  } catch {
    return 'unavailable';
  }
}
