import * as FileSystem from 'expo-file-system/legacy';

export const TAKES_FOLDER_NAME = 'AudioRecorder';

let cachedFolderUri: string | null = null;

/**
 * Single dedicated folder for every take, regardless of which native engine
 * produced it:
 *
 *   /storage/emulated/0/Android/data/com.audiorecorder.app/files/AudioRecorder/
 *
 * App-scoped external files directory. Survives reboots and won't be purged by OS cache sweeps.
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

/** Strips characters that are illegal or hostile in Android/SAF file names. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\?%*:|"<>�-]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const safe = cleaned.length > 0 ? cleaned : 'Take';
  return safe.length > 80 ? safe.slice(0, 80) : safe;
}

export function buildTakeFileName(name: string, extension: string): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return `${sanitizeFileName(name)}${ext}`;
}

/**
 * Relocates a finished take into the dedicated folder under a human-readable name.
 */
export async function moveIntoTakesFolder(
  sourceUri: string | null | undefined,
  name: string,
  extension: string
): Promise<string | null> {
  if (!sourceUri) return null;

  const folder = await ensureTakesFolder();
  const target = `${folder}${buildTakeFileName(name, extension)}`;

  try {
    const info = await FileSystem.getInfoAsync(sourceUri);
    if (!info.exists) {
      return sourceUri;
    }

    // Never clobber an existing take.
    let finalTarget = target;
    if (await pathExists(finalTarget)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      finalTarget = `${folder}${sanitizeFileName(name)}_${stamp}${extension}`;
    }

    await FileSystem.moveAsync({ from: sourceUri, to: finalTarget });
    return finalTarget;
  } catch (e) {
    console.warn('[recordingPaths] Failed to relocate take:', e);
    return sourceUri;
  }
}

export async function pathExists(uri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return Boolean(info.exists);
  } catch {
    return false;
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