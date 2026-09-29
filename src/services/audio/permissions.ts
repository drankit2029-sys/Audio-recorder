// src/services/audio/permissions.ts
import { Platform, PermissionsAndroid } from 'react-native';
import {
  requestRecordingPermissionsAsync,
  requestNotificationPermissionsAsync,
} from 'expo-audio';

export type MissingPermission = 'microphone' | 'notifications' | 'bluetooth';

export interface PermissionGate {
  /** True when capture may start. */
  granted: boolean;
  missing: MissingPermission[];
  /** False once the user ticked "don't ask again" — only a settings trip can fix it. */
  canAskAgain: boolean;
}

const apiLevel = (): number =>
  typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version) || 0;

/**
 * M10: the old bootstrap fired three permission dialogs back to back on the
 * very first launch, before the user had asked for anything. Two of them
 * (notifications, Bluetooth) are only needed in specific situations, and a
 * denial was never explained or re-requested — which quietly breaks recording,
 * because expo-audio throws when it starts a foreground service without
 * POST_NOTIFICATIONS.
 *
 * Permissions are now requested the first time they are actually needed.
 */
export async function ensureCapturePermissions(options: {
  /** When true a missing POST_NOTIFICATIONS blocks the start. */
  blockOnNotifications?: boolean;
  /** Ask for BLUETOOTH_CONNECT (needed to read the name of a BT capsule). */
  needsBluetooth?: boolean;
} = {}): Promise<PermissionGate> {
  const missing: MissingPermission[] = [];
  let canAskAgain = true;

  // 1. Microphone — never optional.
  let micCanAskAgain = true;
  try {
    const mic = await requestRecordingPermissionsAsync();
    if (!mic.granted) {
      missing.push('microphone');
      micCanAskAgain = mic.canAskAgain !== false;
    }
  } catch (e) {
    console.warn('[permissions] microphone request failed:', e);
    missing.push('microphone');
  }

  // 2. Notifications — required to run the recording foreground service on
  //    Android 13+; the MediaRecorder engine refuses to start without it.
  if (apiLevel() >= 33) {
    try {
      const notifications = await requestNotificationPermissionsAsync();
      if (!notifications.granted) {
        missing.push('notifications');
        canAskAgain = notifications.canAskAgain !== false;
      }
    } catch (e) {
      console.warn('[permissions] notification request failed:', e);
      missing.push('notifications');
    }
  }

  // 3. Bluetooth — only needed when a Bluetooth capsule is in play.
  if (options.needsBluetooth && apiLevel() >= 31) {
    try {
      const already = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT as any
      );
      if (!already) {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT as any
        );
        // Bluetooth is a nice-to-have: names fall back to a generic label.
        if (result !== PermissionsAndroid.RESULTS.GRANTED) {
          missing.push('bluetooth');
        }
      }
    } catch (e) {
      console.warn('[permissions] bluetooth request failed:', e);
    }
  }

  const hardBlocks = missing.filter(
    (m) => m === 'microphone' || (m === 'notifications' && options.blockOnNotifications)
  );

  return {
    granted: hardBlocks.length === 0,
    missing,
    canAskAgain: micCanAskAgain && canAskAgain,
  };
}

/** Human-readable copy for the denial alert. */
export function describeMissingPermissions(missing: MissingPermission[], canAskAgain: boolean): string {
  const names: Record<MissingPermission, string> = {
    microphone: 'the microphone',
    notifications: 'notifications (needed to keep recording while the screen is off)',
    bluetooth: 'nearby devices (needed to name a Bluetooth microphone)',
  };
  const list = missing.map((m) => names[m]).join(' and ');
  const where = canAskAgain
    ? 'Grant it on the next prompt.'
    : 'Android will not ask again from inside the app — enable it under Settings → Apps → AudioRecorder → Permissions.';
  return `AudioRecorder needs access to ${list}. ${where}`;
}
