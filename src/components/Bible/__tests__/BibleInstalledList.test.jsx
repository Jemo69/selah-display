import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BibleInstalledList from '../BibleInstalledList';
import useBibleStore from '../../../context/BibleStore';

describe('BibleInstalledList', () => {
  beforeEach(() => {
    useBibleStore.setState({
      bibleMetadata: {},
      bibles: {},
      defaultBibleId: null,
      activeBibleId: null,
    });
  });

  it('shows the installed count and empty state', () => {
    render(<BibleInstalledList darkMode={false} autoImportStatus="done" autoImportDetail="Already installed." />);
    expect(screen.getByTestId('bible-installed-count').textContent).toBe('0');
    expect(screen.getByTestId('bible-installed-empty')).toBeTruthy();
  });

  it('lists installed translations with Default and Active badges', () => {
    useBibleStore.setState({
      bibleMetadata: {
        'bundled-kjv': { id: 'bundled-kjv', name: 'KJV (Bundled Sample)' },
        custom: { id: 'custom', name: 'My Custom' },
      },
      bibles: {
        'bundled-kjv': { name: 'KJV (Bundled Sample)', books: [{ number: 1, name: 'Genesis', chapters: [] }] },
      },
      defaultBibleId: 'bundled-kjv',
      activeBibleId: 'bundled-kjv',
    });
    render(<BibleInstalledList darkMode={false} autoImportStatus="done" autoImportDetail="Auto-imported." />);
    expect(screen.getByTestId('bible-installed-count').textContent).toBe('2');
    expect(screen.getByText('KJV (Bundled Sample)')).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('offers a rescan action while auto-import is idle', () => {
    const onRescan = vi.fn();
    render(<BibleInstalledList darkMode={false} autoImportStatus="done" onRescan={onRescan} />);
    fireEvent.click(screen.getByTestId('bible-rescan-bundled'));
    expect(onRescan).toHaveBeenCalled();
  });
});
