export const OPEN_FILE_NAVIGATOR_EVENT = 'lyricdisplay:open-file-navigator';
export const OPEN_FILE_SAVE_NAVIGATOR_EVENT = 'lyricdisplay:open-file-save-navigator';

export function mergeFileNavigatorStatus(previousStatus, nextStatus = {}) {
  const previous = previousStatus || {};
  if (previous.scanning === true && nextStatus.scanning === true) return previous;
  return { ...previous, ...nextStatus };
}

export function getFolderSelectionNotice(selection) {
  if (!selection) return null;
  const addedCount = Math.max(0, Number(selection.addedCount) || 0);
  const skipped = Array.isArray(selection.skipped) ? selection.skipped : [];
  if (Number(selection.requestedCount) <= 1 && skipped.length === 0) return null;
  if (skipped.length === 0) {
    return {
      title: `${addedCount} folders indexed`,
      message: 'The selected folders are ready to search.',
      variant: 'success',
    };
  }
  const firstReason = skipped[0]?.reason || 'One or more folders could not be indexed.';
  return {
    title: addedCount > 0
      ? `${addedCount} indexed, ${skipped.length} skipped`
      : 'No folders were added',
    message: skipped.length === 1
      ? firstReason
      : `${firstReason} ${skipped.length - 1} other ${skipped.length - 1 === 1 ? 'folder was' : 'folders were'} skipped.`,
    variant: 'warning',
  };
}

export function canUseFileNavigator() {
  return Boolean(window?.electronAPI?.fileNavigator?.getState);
}

export function openFileNavigator({ destination, maxSelections } = {}) {
  if (!canUseFileNavigator()) return false;
  window.dispatchEvent(new CustomEvent(OPEN_FILE_NAVIGATOR_EVENT, {
    detail: { destination, maxSelections },
  }));
  return true;
}

export function pickLyricFileWithNavigator({ destination, maxSelections } = {}) {
  if (!canUseFileNavigator()) return Promise.resolve({ unavailable: true });
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent(OPEN_FILE_NAVIGATOR_EVENT, {
      detail: { destination, maxSelections, onComplete: resolve },
    }));
  });
}

// Single source of truth for turning a navigator selection into file
// content. The modal already loaded the file (indexed open or the
// single-file Browse path), so prefer its payload over re-reading through
// the index, which rejects files outside indexed roots. Lets the failure
// propagate — callers decide between silent null and a toast.
export async function resolveLyricSelectionContent(selection) {
  if (selection?.payload?.success && selection.payload.content) return selection.payload;
  return window.electronAPI.fileNavigator.open(selection.filePath);
}

export async function openLyricsFileThroughNavigator() {
  if (!canUseFileNavigator()) return null;
  const selection = await pickLyricFileWithNavigator({});
  // Cancel is a truthy sentinel (not null) so callers' existing
  // `if (navigatorResult) return` treats it as handled and never falls
  // through to the OS file picker. Null means unavailable (web build).
  if (!selection || selection.canceled) return { canceled: true };
  try {
    const result = await resolveLyricSelectionContent(selection);
    if (result?.success && result.content) {
      window.dispatchEvent(new CustomEvent('lyrics-opened', { detail: result }));
      return result;
    }
  } catch { }
  return null;
}

export function saveWithFileNavigator({
  suggestedName,
  extension,
  availableExtensions,
  initialDirectory = null,
  contentByExtension = null,
} = {}) {
  if (!canUseFileNavigator() || !window.electronAPI?.fileNavigator?.prepareSave) {
    return Promise.resolve({ unavailable: true });
  }

  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent(OPEN_FILE_SAVE_NAVIGATOR_EVENT, {
      detail: {
        suggestedName,
        extension,
        availableExtensions,
        initialDirectory,
        contentByExtension,
        onComplete: resolve,
      },
    }));
  });
}
