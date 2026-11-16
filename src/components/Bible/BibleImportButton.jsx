import React, { useCallback, useId, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import useBibleStore from '../../context/BibleStore';
import useToast from '../../hooks/useToast';
import { diagInfo, diagError } from '../../utils/diagnosticsLog';
import { parseBibleFromFile } from 'shared/bible';

export const BIBLE_IMPORT_LABEL = 'Import Bible Translation';

/**
 * The permanent entry point for adding Bible translation files.
 *
 * Keep this control wired into both User Preferences > Bible and the main
 * Bible panel. It owns parsing and persistence so those surfaces cannot drift
 * apart when the Bible UI is refactored.
 */
export default function BibleImportButton({
  darkMode = false,
  compact = false,
  className = '',
  onImported,
}) {
  const inputId = useId();
  const inputRef = useRef(null);
  const [isImporting, setIsImporting] = useState(false);
  const { showToast } = useToast();
  const addBible = useBibleStore((state) => state.addBible);
  const setActiveBible = useBibleStore((state) => state.setActiveBible);

  const openFilePicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFiles = useCallback(async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    setIsImporting(true);
    const startedAt = Date.now();
    let imported = 0;
    let failed = 0;
    try {
      for (const file of files) {
        const fileStartedAt = Date.now();
        try {
          const bible = await parseBibleFromFile(file);
          if (!bible?.books?.length) {
            throw new Error('No books found in Bible file');
          }

          const id = bible.id || `bible_${Date.now()}`;
          await addBible(id, bible);
          await setActiveBible(id);
          const books = Array.isArray(bible.books) ? bible.books.length : 0;
          imported += 1;
          diagInfo('bible', 'translation imported', {
            fileName: file.name,
            bytes: file.size,
            id,
            books,
            durationMs: Date.now() - fileStartedAt,
          });
          onImported?.({ id, bible, file });
          showToast({
            title: 'Bible imported',
            message: `${bible.name || file.name} has been added to your library`,
            variant: 'success',
          });
        } catch (error) {
          failed += 1;
          diagError('bible', 'translation import failed', {
            fileName: file.name,
            bytes: file.size,
            durationMs: Date.now() - fileStartedAt,
            error: error?.message || String(error),
          });
          showToast({
            title: 'Import failed',
            message: error?.message || `Could not parse ${file.name}`,
            variant: 'error',
          });
        }
      }
    } finally {
      // Allow the same file to be selected again after a failed or successful import.
      event.target.value = '';
      setIsImporting(false);
      diagInfo('bible', 'import batch finished', {
        files: files.length,
        imported,
        failed,
        durationMs: Date.now() - startedAt,
      });
    }
  }, [addBible, onImported, setActiveBible, showToast]);

  const sizeClasses = compact
    ? 'px-2.5 py-1.5 text-[11px]'
    : 'w-full justify-center px-4 py-2.5 text-sm';

  const colorClasses = darkMode
    ? 'border-blue-500/40 bg-blue-500/15 text-blue-200 hover:bg-blue-500/25'
    : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100';

  return (
    <>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept=".xml,.json"
        multiple
        onChange={handleFiles}
        className="hidden"
        aria-label="Choose Bible translation files"
        data-testid="bible-import-input"
      />
      <button
        type="button"
        onClick={openFilePicker}
        disabled={isImporting}
        aria-label={BIBLE_IMPORT_LABEL}
        title="Import a Bible translation file (.xml / .json: Zefania, OSIS, Beblia, or OpenSong)"
        data-testid="bible-import-button"
        className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 ${sizeClasses} ${colorClasses} ${className}`}
      >
        {isImporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
        {isImporting ? 'Importing…' : BIBLE_IMPORT_LABEL}
      </button>
    </>
  );
}
