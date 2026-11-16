import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import useLyricsStore from '../../../context/LyricsStore';
import FreeNoteControlPanel from '../FreeNoteControlPanel';

vi.mock('../../../context/ControlSocketProvider', () => ({
  useControlSocket: () => null,
}));

vi.mock('../../../hooks/useToast', () => ({
  default: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../../hooks/useOutputTemplateSync', () => ({
  useOutputTemplateSync: () => ({ applyForMode: vi.fn() }),
}));

const seedDraft = {
  id: 'draft-rail-1',
  title: 'Sunday Notes',
  content: '# Welcome\nWe are glad you are here!\n---\n## Events\n- Prayer at 7 PM\n---\n> See you Sunday',
  updatedAt: Date.now(),
};

function renderPanel(props = {}) {
  return render(
    <FreeNoteControlPanel
      darkMode
      isOutputOn
      onBroadcastNote={props.onBroadcastNote || vi.fn()}
      onToggleOutput={props.onToggleOutput}
      {...props}
    />
  );
}

describe('FreeNoteControlPanel vertical rail redesign', () => {
  beforeEach(() => {
    useLyricsStore.setState({
      freeNotesDrafts: [seedDraft],
      isOutputOn: true,
      modeTemplates: {},
    });
  });

  it('renders the 212px vertical slide rail with one entry per slide', () => {
    const { container } = renderPanel();
    const rail = screen.getByTestId('freenote-slide-rail');
    expect(rail).toBeInTheDocument();
    expect(rail.className).toMatch('w-[212px]');
    expect(screen.getByTestId('freenote-slide-0')).toBeInTheDocument();
    expect(screen.getByTestId('freenote-slide-1')).toBeInTheDocument();
    expect(screen.getByTestId('freenote-slide-2')).toBeInTheDocument();
    // Rail offers a slide-break shortcut
    expect(within(rail).getByRole('button', { name: /slide break/i })).toBeInTheDocument();
    expect(container.querySelector('[data-testid="freenote-slide-rail"]')).not.toBeNull();
  });

  it('single click previews without broadcasting; double-click broadcasts that slide', () => {
    const onBroadcastNote = vi.fn();
    renderPanel({ onBroadcastNote });

    // Slide 1 is LIVE initially
    expect(screen.getByTestId('freenote-slide-0').textContent).toMatch('LIVE');

    // Single click on slide 2 only moves the preview
    fireEvent.click(screen.getByTestId('freenote-slide-1'));
    expect(onBroadcastNote).not.toHaveBeenCalled();
    expect(screen.getByTestId('freenote-slide-1').textContent).toMatch('LIVE');

    // Double-click broadcasts slide 3 (index 2)
    fireEvent.doubleClick(screen.getByTestId('freenote-slide-2'));
    expect(onBroadcastNote).toHaveBeenCalledTimes(1);
    expect(onBroadcastNote.mock.calls[0][1]).toBe(2);
  });

  it('bottom dock has prev/next, dots, counter, compact preview, broadcast and output toggle', () => {
    const onBroadcastNote = vi.fn();
    renderPanel({ onBroadcastNote });

    const dock = screen.getByTestId('freenote-broadcast-dock');
    expect(dock).toBeInTheDocument();

    expect(within(dock).getByLabelText('Previous slide')).toBeInTheDocument();
    expect(within(dock).getByLabelText('Next slide')).toBeInTheDocument();
    expect(within(dock).getByText('Slide 1 of 3')).toBeInTheDocument();
    expect(within(dock).getByLabelText('Preview slide 2')).toBeInTheDocument();

    // 240px compact LIVE preview rendered with template colors
    const compact = screen.getByTestId('freenote-preview-compact');
    expect(compact).toBeInTheDocument();
    expect(compact.className).toMatch('w-[240px]');

    // Prev/next move the preview without broadcasting
    fireEvent.click(within(dock).getByLabelText('Next slide'));
    expect(within(dock).getByText('Slide 2 of 3')).toBeInTheDocument();
    expect(onBroadcastNote).not.toHaveBeenCalled();

    // Big broadcast button sends the active slide
    fireEvent.click(within(dock).getByRole('button', { name: /Broadcast Slide 2 to Displays/i }));
    expect(onBroadcastNote).toHaveBeenCalledTimes(1);
    expect(onBroadcastNote.mock.calls[0][1]).toBe(1);

    expect(within(dock).getByRole('button', { name: /Displays LIVE/i })).toBeInTheDocument();
  });

  it('keeps the full-width center editor with toolbar and Ctrl+Enter broadcast', () => {
    const onBroadcastNote = vi.fn();
    renderPanel({ onBroadcastNote });

    expect(screen.getByTestId('freenote-editor')).toBeInTheDocument();
    expect(screen.getByTitle('Bold (**text**)')).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText(/Type your notes/i);
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onBroadcastNote).toHaveBeenCalledTimes(1);
  });
});
