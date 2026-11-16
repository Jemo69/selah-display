import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  FileText, Plus, Trash2, Radio,
  Quote, Layers, Clock, BookOpen,
  Bold, Italic, Highlighter, List, ListOrdered,
  Eye, Columns, Edit3, Monitor,
  ChevronLeft, ChevronRight
} from 'lucide-react';
import useLyricsStore from '../../context/LyricsStore';
import useBibleStore from '../../context/BibleStore';
import useToast from '../../hooks/useToast';
import { useOutputTemplateSync } from '../../hooks/useOutputTemplateSync';
import { useControlSocket } from '../../context/ControlSocketProvider';
import {
  splitFreeNoteSlides,
  extractFreeNoteTitle,
  expandFreeNoteText,
  createFreeNoteDraft,
  calculateNoteBaseFontSize,
} from '../../utils/freeNote';
import { freeNoteTemplates } from '../../utils/outputTemplates';
import MarkdownNoteRenderer from './MarkdownNoteRenderer';

export default function FreeNoteControlPanel({ darkMode, onBroadcastNote, isOutputOn: propIsOutputOn, onToggleOutput }) {
  const { showToast } = useToast();
  const { applyForMode } = useOutputTemplateSync();
  const controlSocket = useControlSocket?.() || null;

  const loadFreeNote = useLyricsStore((s) => s.loadFreeNote);
  const selectLine = useLyricsStore((s) => s.selectLine);
  const selectedLine = useLyricsStore((s) => s.selectedLine);
  const freeNotesDrafts = useLyricsStore((s) => s.freeNotesDrafts) || [];
  const saveFreeNoteDraft = useLyricsStore((s) => s.saveFreeNoteDraft);
  const deleteFreeNoteDraft = useLyricsStore((s) => s.deleteFreeNoteDraft);
  const setModeTemplate = useLyricsStore((s) => s.setModeTemplate);
  const modeTemplates = useLyricsStore((s) => s.modeTemplates) || {};
  const storeIsOutputOn = useLyricsStore((s) => s.isOutputOn);
  const setIsOutputOn = useLyricsStore((s) => s.setIsOutputOn);

  const isOutputOn = propIsOutputOn !== undefined ? propIsOutputOn : storeIsOutputOn;

  const getVerseText = useBibleStore((s) => s.getVerseText);
  const activeBibleId = useBibleStore((s) => s.activeBibleId);

  const [activeDraftId, setActiveDraftId] = useState(null);
  const [title, setTitle] = useState('New Announcement');
  const [content, setContent] = useState('');
  const [activeSlideIdx, setActiveSlideIdx] = useState(0);
  const [selectedTemplateId, setSelectedTemplateId] = useState('freenote-standard');
  const [showDraftsList, setShowDraftsList] = useState(false);
  const [viewMode, setViewMode] = useState('split'); // 'split' | 'edit' | 'preview'

  const textareaRef = useRef(null);

  // Initialize with a blank draft or first existing draft
  useEffect(() => {
    if (freeNotesDrafts.length > 0 && !activeDraftId) {
      const first = freeNotesDrafts[0];
      setActiveDraftId(first.id);
      setTitle(first.title || 'Free Note');
      setContent(first.content || '');
    } else if (!activeDraftId) {
      const blank = createFreeNoteDraft('Welcome & Announcements', '# Welcome to Our Service\nWe are glad you are here!\n---\n## Upcoming Events\n- **Wednesday**: Midweek Prayer at 7 PM\n- **Friday**: Youth Gathering at 6 PM\n- Remember to ==bring your Bible==\n> "For with God nothing shall be impossible." — Luke 1:37');
      saveFreeNoteDraft(blank);
      setActiveDraftId(blank.id);
      setTitle(blank.title);
      setContent(blank.content);
    }
  }, [freeNotesDrafts, activeDraftId, saveFreeNoteDraft]);

  // Split into slides
  const slides = useMemo(() => {
    const rawSlides = splitFreeNoteSlides(content);
    return rawSlides.length > 0 ? rawSlides : [content.trim() || ''];
  }, [content]);

  // Keep the active slide in bounds when slides shrink
  useEffect(() => {
    if (activeSlideIdx > slides.length - 1) {
      setActiveSlideIdx(Math.max(0, slides.length - 1));
    }
  }, [slides.length, activeSlideIdx]);

  // Current active template definition
  const currentTemplate = useMemo(() => {
    return freeNoteTemplates.find((t) => t.id === selectedTemplateId) || freeNoteTemplates[0];
  }, [selectedTemplateId]);

  // Current slide content for preview
  const activeSlideContent = useMemo(() => {
    return slides[activeSlideIdx] || content.trim() || '';
  }, [slides, activeSlideIdx, content]);

  // Autosave draft changes
  useEffect(() => {
    if (!activeDraftId) return;
    const timer = setTimeout(() => {
      saveFreeNoteDraft({
        id: activeDraftId,
        title: title.trim() || extractFreeNoteTitle(content),
        content,
        updatedAt: Date.now(),
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [activeDraftId, title, content, saveFreeNoteDraft]);

  const handleNewDraft = useCallback(() => {
    const newDraft = createFreeNoteDraft('New Note', '');
    saveFreeNoteDraft(newDraft);
    setActiveDraftId(newDraft.id);
    setTitle(newDraft.title);
    setContent(newDraft.content);
    setActiveSlideIdx(0);
    if (textareaRef.current) textareaRef.current.focus();
    showToast({ title: 'New note created', message: 'Ready to type.', variant: 'info' });
  }, [saveFreeNoteDraft, showToast]);

  const handleSelectDraft = useCallback((draft) => {
    setActiveDraftId(draft.id);
    setTitle(draft.title || 'Free Note');
    setContent(draft.content || '');
    setActiveSlideIdx(0);
    setShowDraftsList(false);
  }, []);

  const handleDeleteDraft = useCallback((id, e) => {
    e.stopPropagation();
    deleteFreeNoteDraft(id);
    if (activeDraftId === id) {
      setActiveDraftId(null);
      setContent('');
      setTitle('New Note');
    }
    showToast({ title: 'Draft deleted', message: 'Note was removed.', variant: 'info' });
  }, [activeDraftId, deleteFreeNoteDraft, showToast]);

  const handleToggleScreenOutput = useCallback(() => {
    const next = !isOutputOn;
    if (typeof onToggleOutput === 'function') {
      onToggleOutput(next);
    } else {
      setIsOutputOn(next);
      controlSocket?.emitOutputToggle?.(next);
    }
  }, [isOutputOn, onToggleOutput, setIsOutputOn, controlSocket]);

  // Broadcast note to outputs
  const handleBroadcast = useCallback((slideIndexToBroadcast = null) => {
    const idx = Number.isInteger(slideIndexToBroadcast) ? slideIndexToBroadcast : activeSlideIdx;
    const validIndex = Math.max(0, Math.min(idx, slides.length - 1));

    // Expand shortcodes (e.g. b:John 3:16)
    const expandedSlides = slides.map((slide) => {
      return expandFreeNoteText(slide, {
        resolveBible: (ref) => {
          if (!activeBibleId) return null;
          const match = ref.match(/^([1-3]?\s*[A-Za-z]+)\s*(\d+):(\d+)(?:-(\d+))?$/);
          if (match) {
            const [, book, chapter, verse] = match;
            const text = getVerseText(activeBibleId, book.trim(), parseInt(chapter, 10), parseInt(verse, 10));
            if (text) return `${text}\n\n— ${ref}`;
          }
          return null;
        }
      });
    });

    const noteTitle = title.trim() || extractFreeNoteTitle(content);
    const notePayload = {
      title: noteTitle,
      rawText: content,
      lines: expandedSlides,
      slides: expandedSlides,
      id: activeDraftId || `freenote_${Date.now()}`,
      selectedLine: validIndex,
      slideIndex: validIndex,
    };

    // Automatically turn ON output display if it's currently OFF
    if (!isOutputOn) {
      if (typeof onToggleOutput === 'function') {
        onToggleOutput(true);
      } else {
        setIsOutputOn(true);
        controlSocket?.emitOutputToggle?.(true);
      }
    }

    if (typeof onBroadcastNote === 'function') {
      onBroadcastNote(notePayload, validIndex);
    } else {
      loadFreeNote(notePayload);
      selectLine(validIndex);
      applyForMode('freenote', { force: true, manual: true });

      controlSocket?.emitFreeNoteLoaded?.(notePayload);
      controlSocket?.emitLyricsLoad?.(expandedSlides);
      controlSocket?.emitLineUpdate?.({ index: validIndex });
      controlSocket?.emitFileNameUpdate?.(noteTitle);
      controlSocket?.emitContentModeUpdate?.('freenote', '', noteTitle);
    }

    showToast({
      title: 'Free Note On Screen',
      message: `Broadcasting slide ${validIndex + 1} of ${expandedSlides.length}`,
      variant: 'success',
      duration: 3000,
    });
  }, [activeSlideIdx, slides, title, content, activeDraftId, isOutputOn, onToggleOutput, setIsOutputOn, controlSocket, onBroadcastNote, loadFreeNote, selectLine, applyForMode, showToast, activeBibleId, getVerseText]);

  // Template change
  const handleTemplateChange = useCallback((tplId) => {
    setSelectedTemplateId(tplId);
    setModeTemplate('output1', 'freenote', tplId);
    setModeTemplate('output2', 'freenote', tplId);
    if (tplId.includes('alert')) {
      setModeTemplate('stage', 'freenote', 'freenote-stage-alert');
    } else {
      setModeTemplate('stage', 'freenote', 'freenote-stage-focus');
    }
    applyForMode('freenote', { force: true, manual: true });
    showToast({ title: 'Template applied', message: `Free Note template updated.`, variant: 'info' });
  }, [setModeTemplate, applyForMode, showToast]);

  // Helper to insert markdown tokens at cursor
  const handleInsertToken = (prefix, suffix = '', isBlock = false) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = content.substring(start, end);

    let replacement;
    let newCursorPos;

    if (isBlock) {
      const before = content.substring(0, start);
      const after = content.substring(end);
      const isStartOfLine = start === 0 || before.endsWith('\n');
      const insertPrefix = isStartOfLine ? prefix : `\n${prefix}`;
      replacement = `${insertPrefix}${selected || 'Heading'}${suffix}`;
      setContent(`${before}${replacement}${after}`);
      newCursorPos = start + replacement.length;
    } else {
      const before = content.substring(0, start);
      const after = content.substring(end);
      const textToWrap = selected || 'text';
      replacement = `${prefix}${textToWrap}${suffix}`;
      setContent(`${before}${replacement}${after}`);
      newCursorPos = start + prefix.length + textToWrap.length + suffix.length;
    }

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 10);
  };

  // Hotkeys inside the textarea
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleBroadcast(activeSlideIdx);
    }
  };

  const handleInsertSlideBreak = () => {
    setContent((prev) => `${prev.trim()}\n\n---\n\n`);
    if (textareaRef.current) textareaRef.current.focus();
  };

  const handleInsertScripture = () => {
    setContent((prev) => `${prev.trim()}\n\nb:John 3:16\n`);
    if (textareaRef.current) textareaRef.current.focus();
  };

  // Slide navigation (preview only — broadcasting stays explicit)
  const goToSlide = useCallback((idx) => {
    setActiveSlideIdx(Math.max(0, Math.min(idx, slides.length - 1)));
  }, [slides.length]);

  const goPrevSlide = useCallback(() => {
    setActiveSlideIdx((i) => Math.max(0, i - 1));
  }, []);

  const goNextSlide = useCallback(() => {
    setActiveSlideIdx((i) => Math.min(slides.length - 1, i + 1));
  }, [slides.length]);

  const templateBg = currentTemplate?.output1?.fullScreenBackgroundColor || '#000000';
  const templateFg = currentTemplate?.output1?.fontColor || '#FFFFFF';
  const templateFont = currentTemplate?.output1?.fontStyle || 'inherit';
  const templateAlign = currentTemplate?.output1?.textAlign || 'center';

  return (
    <div className={`flex flex-col h-full overflow-hidden ${darkMode ? 'text-gray-100 bg-gray-950/20' : 'text-gray-900 bg-gray-50/40'}`}>
      {/* Top Header */}
      <div className={`p-4 border-b space-y-3 shrink-0 ${darkMode ? 'border-gray-800 bg-gray-900/40' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <FileText className="w-4 h-4 text-amber-500 shrink-0" />
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Note / Announcement Title"
              className={`w-full text-xs font-bold px-2.5 py-1.5 rounded-lg border focus:outline-none focus:ring-1 focus:ring-amber-500 truncate ${
                darkMode ? 'bg-gray-950 border-gray-800 text-white' : 'bg-gray-50 border-gray-300 text-gray-900'
              }`}
            />
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => setShowDraftsList(!showDraftsList)}
              title="Saved Drafts"
              className={`px-2 py-1.5 text-xs font-medium rounded-lg border flex items-center gap-1.5 transition-colors ${
                showDraftsList
                  ? 'bg-amber-500 text-black border-amber-600'
                  : darkMode ? 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span>Notes ({freeNotesDrafts.length})</span>
            </button>

            <button
              onClick={handleNewDraft}
              title="Create Blank Note"
              className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border flex items-center gap-1 transition-colors ${
                darkMode ? 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New</span>
            </button>
          </div>
        </div>

        {/* Drafts Drawer */}
        {showDraftsList && (
          <div className={`p-2 rounded-xl border max-h-48 overflow-y-auto space-y-1.5 ${darkMode ? 'bg-gray-950 border-gray-800' : 'bg-white border-gray-200 shadow-sm'}`}>
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider px-2 py-1">Saved Free Notes</div>
            {freeNotesDrafts.length === 0 ? (
              <div className="text-xs text-gray-500 p-2 text-center">No saved notes yet.</div>
            ) : (
              freeNotesDrafts.map((draft) => (
                <div
                  key={draft.id}
                  onClick={() => handleSelectDraft(draft)}
                  className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition-colors ${
                    activeDraftId === draft.id
                      ? darkMode ? 'bg-amber-500/20 text-amber-300 font-semibold' : 'bg-amber-50 text-amber-900 font-semibold'
                      : darkMode ? 'hover:bg-gray-900 text-gray-300' : 'hover:bg-gray-100 text-gray-700'
                  }`}
                >
                  <span className="truncate flex-1">{draft.title || 'Untitled Note'}</span>
                  <button
                    onClick={(e) => handleDeleteDraft(draft.id, e)}
                    title="Delete Draft"
                    className="p-1 text-gray-400 hover:text-red-500 rounded transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Controls Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className={`text-[11px] font-semibold ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Template:</span>
              <select
                value={selectedTemplateId}
                onChange={(e) => handleTemplateChange(e.target.value)}
                className={`text-xs px-2 py-1 rounded-lg border font-medium focus:outline-none ${
                  darkMode ? 'bg-gray-950 border-gray-800 text-white' : 'bg-white border-gray-300 text-gray-900'
                }`}
              >
                {freeNoteTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </div>

            {/* View Mode Toggle */}
            <div className={`flex items-center p-0.5 rounded-lg border ${darkMode ? 'bg-gray-900 border-gray-800' : 'bg-gray-100 border-gray-200'}`}>
              <button
                type="button"
                onClick={() => setViewMode('split')}
                title="Split View (Editor + Live Preview Dock)"
                className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors ${
                  viewMode === 'split' ? 'bg-amber-500 text-black font-semibold' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Columns className="w-3 h-3" />
                <span className="hidden sm:inline">Split</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('edit')}
                title="Editor Only"
                className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors ${
                  viewMode === 'edit' ? 'bg-amber-500 text-black font-semibold' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Edit3 className="w-3 h-3" />
                <span className="hidden sm:inline">Edit</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('preview')}
                title="Preview Only"
                className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors ${
                  viewMode === 'preview' ? 'bg-amber-500 text-black font-semibold' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Eye className="w-3 h-3" />
                <span className="hidden sm:inline">Preview</span>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={handleInsertSlideBreak}
              title="Add Slide Break (---)"
              className={`px-2 py-1 text-[11px] font-medium rounded border flex items-center gap-1 transition-colors ${
                darkMode ? 'bg-gray-800 border-gray-700 hover:bg-gray-700 text-gray-200' : 'bg-gray-100 border-gray-300 hover:bg-gray-200 text-gray-700'
              }`}
            >
              <Layers className="w-3 h-3" />
              <span>+ Break (---)</span>
            </button>
            <button
              onClick={handleInsertScripture}
              title="Add Scripture Shortcode"
              className={`px-2 py-1 text-[11px] font-medium rounded border flex items-center gap-1 transition-colors ${
                darkMode ? 'bg-gray-800 border-gray-700 hover:bg-gray-700 text-gray-200' : 'bg-gray-100 border-gray-300 hover:bg-gray-200 text-gray-700'
              }`}
            >
              <BookOpen className="w-3 h-3" />
              <span>+ Scripture</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Body: vertical slide rail + center editor */}
      <div className="flex-1 flex flex-row min-h-0 overflow-hidden">
        {/* Left vertical slide rail */}
        <aside
          data-testid="freenote-slide-rail"
          className={`w-[212px] shrink-0 flex flex-col min-h-0 border-r ${darkMode ? 'border-gray-800 bg-gray-900/30' : 'border-gray-200 bg-white/60'}`}
        >
          <div className="px-3 pt-3 pb-1.5 shrink-0">
            <div className="text-[11px] font-semibold text-gray-400 flex items-center justify-between">
              <span>Slides ({slides.length})</span>
            </div>
            <div className="text-[10px] text-gray-500 leading-tight mt-0.5">
              Click to preview · double-click to broadcast
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2 min-h-0">
            {slides.map((slide, idx) => (
              <button
                key={idx}
                type="button"
                data-testid={`freenote-slide-${idx}`}
                onClick={() => goToSlide(idx)}
                onDoubleClick={() => {
                  setActiveSlideIdx(idx);
                  handleBroadcast(idx);
                }}
                title="Click to preview, double-click to broadcast"
                className={`w-full px-2.5 py-2 rounded-xl border text-left transition-all overflow-hidden ${
                  activeSlideIdx === idx
                    ? darkMode
                      ? 'bg-amber-500/20 border-amber-500 text-white shadow-sm ring-1 ring-amber-500/50'
                      : 'bg-amber-50 border-amber-400 text-amber-950 shadow-sm ring-1 ring-amber-400'
                    : darkMode
                      ? 'bg-gray-900 border-gray-800 text-gray-300 hover:bg-gray-800'
                      : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between font-mono text-[10px] opacity-70 mb-0.5">
                  <span>Slide {idx + 1}</span>
                  {activeSlideIdx === idx && (
                    <span className="text-[9px] font-bold text-amber-500 uppercase tracking-wider">LIVE</span>
                  )}
                </div>
                <div className="truncate text-xs font-semibold">
                  {(slide.split('\n')[0] || '').replace(/^#+\s*/, '') || '(Empty)'}
                </div>
                <div className="truncate text-[10px] opacity-60 mt-0.5">
                  {(slide.split('\n')[1] || '').replace(/^[#>*\-\d.\s]+/, '').slice(0, 40)}
                </div>
              </button>
            ))}
          </div>
          <div className={`p-2 border-t shrink-0 ${darkMode ? 'border-gray-800' : 'border-gray-200'}`}>
            <button
              type="button"
              onClick={handleInsertSlideBreak}
              title="Add Slide Break (---)"
              className={`w-full px-2 py-1.5 text-[11px] font-medium rounded-lg border flex items-center justify-center gap-1 transition-colors ${
                darkMode ? 'bg-gray-800 border-gray-700 hover:bg-gray-700 text-gray-200' : 'bg-gray-100 border-gray-300 hover:bg-gray-200 text-gray-700'
              }`}
            >
              <Layers className="w-3 h-3" />
              <span>+ Slide break</span>
            </button>
          </div>
        </aside>

        {/* Center: full-width editor (split/edit) or large preview (preview) */}
        <div className="flex-1 flex flex-col min-h-0 p-4 overflow-hidden">
          {(viewMode === 'edit' || viewMode === 'split') && (
            <div data-testid="freenote-editor" className="flex-1 flex flex-col min-h-0 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-gray-400 font-semibold px-1 shrink-0">
                <span>Type Markdown (<kbd className="px-1 py-0.5 rounded bg-gray-800 font-mono text-[10px]">Ctrl+Enter</kbd> Broadcast)</span>
                <span>Slide {Math.min(activeSlideIdx + 1, slides.length)} of {slides.length}</span>
              </div>

              {/* Markdown Formatting Toolbar */}
              <div className={`flex flex-wrap items-center gap-1 px-2 py-1 rounded-lg border text-xs shrink-0 ${
                darkMode ? 'bg-gray-900/90 border-gray-800' : 'bg-gray-100/90 border-gray-300'
              }`}>
                <button
                  type="button"
                  onClick={() => handleInsertToken('# ', '', true)}
                  title="Heading 1 (# Text)"
                  className="px-1.5 py-0.5 rounded hover:bg-gray-700/50 font-black text-xs text-amber-500"
                >
                  H1
                </button>
                <button
                  type="button"
                  onClick={() => handleInsertToken('## ', '', true)}
                  title="Heading 2 (## Text)"
                  className="px-1.5 py-0.5 rounded hover:bg-gray-700/50 font-bold text-xs"
                >
                  H2
                </button>
                <button
                  type="button"
                  onClick={() => handleInsertToken('### ', '', true)}
                  title="Heading 3 (### Text)"
                  className="px-1.5 py-0.5 rounded hover:bg-gray-700/50 font-semibold text-xs"
                >
                  H3
                </button>
                <div className="w-[1px] h-3.5 bg-gray-500/30 mx-0.5" />
                <button
                  type="button"
                  onClick={() => handleInsertToken('**', '**', false)}
                  title="Bold (**text**)"
                  className="p-1 rounded hover:bg-gray-700/50"
                >
                  <Bold className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleInsertToken('*', '*', false)}
                  title="Italic (*text*)"
                  className="p-1 rounded hover:bg-gray-700/50"
                >
                  <Italic className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleInsertToken('==', '==', false)}
                  title="Obsidian Highlight (==text==)"
                  className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold flex items-center gap-1 hover:bg-amber-500/30"
                >
                  <Highlighter className="w-3.5 h-3.5" />
                  <span className="text-[10px]">==H==</span>
                </button>
                <div className="w-[1px] h-3.5 bg-gray-500/30 mx-0.5" />
                <button
                  type="button"
                  onClick={() => handleInsertToken('> ', '', true)}
                  title="Blockquote / Callout (> Text)"
                  className="p-1 rounded hover:bg-gray-700/50"
                >
                  <Quote className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleInsertToken('- ', '', true)}
                  title="Bullet List (- Item)"
                  className="p-1 rounded hover:bg-gray-700/50"
                >
                  <List className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleInsertToken('1. ', '', true)}
                  title="Numbered List (1. Item)"
                  className="p-1 rounded hover:bg-gray-700/50"
                >
                  <ListOrdered className="w-3.5 h-3.5" />
                </button>
              </div>

              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type your notes or announcements here in Markdown...&#10;&#10;# Main Title&#10;## Subtitle or Topic&#10;- **Key Point 1** with detail&#10;- ==Important reminder== (highlight)&#10;> Inspiring quote or scripture&#10;&#10;Use '---' to separate slides."
                className={`w-full flex-1 p-3 rounded-xl border text-sm font-sans resize-none focus:outline-none focus:ring-1 focus:ring-amber-500 leading-relaxed min-h-0 ${
                  darkMode ? 'bg-gray-950/80 border-gray-800 text-white placeholder-gray-600' : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 shadow-sm'
                }`}
              />
            </div>
          )}

          {/* Large presentation preview (preview mode) */}
          {viewMode === 'preview' && (
            <div className="flex-1 flex flex-col min-h-0 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-gray-400 font-semibold px-1 shrink-0">
                <span className="flex items-center gap-1.5">
                  <Monitor className="w-3.5 h-3.5 text-amber-500" />
                  <span>Live Slide Preview (Slide {Math.min(activeSlideIdx + 1, slides.length)})</span>
                </span>
                <span className="text-[10px] text-amber-400 font-mono">{currentTemplate?.title || 'Standard'}</span>
              </div>

              <div
                className={`flex-1 rounded-xl border p-6 flex flex-col items-center justify-center overflow-auto shadow-inner relative transition-all ${
                  darkMode ? 'bg-black/90 border-gray-800' : 'bg-gray-900 border-gray-700 text-white'
                }`}
                style={{
                  backgroundColor: templateBg,
                  color: templateFg,
                  fontFamily: templateFont,
                }}
              >
                <div className="w-full max-w-xl text-center">
                  <MarkdownNoteRenderer
                    content={activeSlideContent}
                    baseFontSize={calculateNoteBaseFontSize(activeSlideContent, {
                      containerHeight: 380,
                      targetFontSize: 30,
                      minFontSize: 16,
                      maxFontSize: 42,
                    })}
                    fontColor={templateFg}
                    textAlign={templateAlign}
                    fontStyle={templateFont}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom broadcast dock: nav + compact LIVE preview + broadcast + output toggle */}
      <div
        data-testid="freenote-broadcast-dock"
        className={`shrink-0 border-t p-3 flex items-center gap-3 ${darkMode ? 'border-gray-800 bg-gray-900/40' : 'border-gray-200 bg-white'}`}
      >
        {/* Prev / next + dots + counter */}
        <div className="flex flex-col gap-1.5 shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={goPrevSlide}
              disabled={activeSlideIdx <= 0}
              title="Previous slide (preview)"
              aria-label="Previous slide"
              className={`p-1.5 rounded-lg border transition-colors disabled:opacity-40 ${
                darkMode ? 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[11px] font-semibold text-gray-400 whitespace-nowrap px-1">
              Slide {Math.min(activeSlideIdx + 1, slides.length)} of {slides.length}
            </span>
            <button
              type="button"
              onClick={goNextSlide}
              disabled={activeSlideIdx >= slides.length - 1}
              title="Next slide (preview)"
              aria-label="Next slide"
              className={`p-1.5 rounded-lg border transition-colors disabled:opacity-40 ${
                darkMode ? 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-1 max-w-[180px] overflow-x-auto py-0.5">
            {slides.map((_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => goToSlide(idx)}
                title={`Preview slide ${idx + 1}`}
                aria-label={`Preview slide ${idx + 1}`}
                className={`w-2.5 h-2.5 rounded-full shrink-0 transition-colors ${
                  activeSlideIdx === idx ? 'bg-amber-500' : darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-300 hover:bg-gray-400'
                }`}
              />
            ))}
          </div>
        </div>

        {/* 240px compact LIVE preview (hidden in editor-only mode) */}
        {viewMode !== 'edit' && (
          <div
            data-testid="freenote-preview-compact"
            className="w-[240px] shrink-0 rounded-lg border overflow-hidden hidden sm:block"
            style={{ backgroundColor: templateBg, color: templateFg }}
          >
            <div className="flex items-center justify-between px-2 pt-1.5">
              <span className="text-[9px] font-bold uppercase tracking-wider text-amber-500">Live preview</span>
              <span className="text-[9px] font-mono opacity-60">Slide {Math.min(activeSlideIdx + 1, slides.length)}/{slides.length}</span>
            </div>
            <div className="h-[110px] overflow-hidden px-2.5 pb-2 text-center">
              <MarkdownNoteRenderer
                content={activeSlideContent}
                baseFontSize={calculateNoteBaseFontSize(activeSlideContent, {
                  containerHeight: 110,
                  targetFontSize: 15,
                  minFontSize: 8,
                  maxFontSize: 17,
                })}
                fontColor={templateFg}
                textAlign={templateAlign}
                fontStyle={templateFont}
              />
            </div>
          </div>
        )}

        <button
          onClick={() => handleBroadcast(activeSlideIdx)}
          className="flex-1 py-3 px-4 rounded-xl font-bold text-sm bg-gradient-to-r from-amber-500 to-amber-600 text-black hover:from-amber-400 hover:to-amber-500 shadow-lg shadow-amber-500/10 flex items-center justify-center gap-2 transition-all duration-200 min-w-0"
        >
          <Radio className="w-4 h-4 animate-pulse shrink-0" />
          <span className="truncate">Broadcast Slide {Math.min(activeSlideIdx + 1, slides.length)} to Displays</span>
        </button>

        <button
          onClick={handleToggleScreenOutput}
          className={`px-4 py-3 rounded-xl border flex items-center gap-2 text-xs font-semibold transition-all shrink-0 ${
            isOutputOn
              ? darkMode
                ? 'bg-green-500/20 text-green-300 border-green-500/40 hover:bg-green-500/30'
                : 'bg-green-50 text-green-700 border-green-300 hover:bg-green-100'
              : darkMode
                ? 'bg-red-500/20 text-red-300 border-red-500/40 hover:bg-red-500/30'
                : 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100'
          }`}
          title={isOutputOn ? 'Screen output is LIVE. Click to blackout.' : 'Screen output is OFF (blackout). Click to turn on.'}
        >
          {isOutputOn ? (
            <>
              <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
              <span>Displays LIVE</span>
            </>
          ) : (
            <>
              <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <span>Displays OFF</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
