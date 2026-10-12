/** Optional host permissions: granted only when a setting actually needs them. */

export async function hasOrigins(origins = []) {
  if (!origins.length) return true;
  if (!chrome.permissions?.contains) return false;
  return chrome.permissions.contains({ origins });
}

export async function missingOrigins(origins = []) {
  if (!origins.length) return [];
  if (await hasOrigins(origins)) return [];
  return origins;
}

/**
 * Request origins. Must be called from a user gesture, so the popup and the
 * options page are the only valid callers.
 */
export async function requestOrigins(origins = []) {
  if (!origins.length) return true;
  if (!chrome.permissions?.request) return false;
  return chrome.permissions.request({ origins });
}

export function originOf(url) {
  try {
    return new URL(url).origin + '/*';
  } catch {
    return null;
  }
}

export function onPermissionsChanged(handler) {
  if (!chrome.permissions?.onAdded) return;
  chrome.permissions.onAdded.addListener(handler);
  chrome.permissions.onRemoved.addListener(handler);
}
