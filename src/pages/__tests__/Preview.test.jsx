import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import React, { Suspense } from 'react';

const Preview = React.lazy(() => import('../Preview.jsx'));

describe('Preview route smoke', () => {
  it('renders all tiles with labels', async () => {
    render(
      <MemoryRouter initialEntries={['/preview']}>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/preview" element={<Preview />} />
          </Routes>
        </Suspense>
      </MemoryRouter>
    );
    expect(
      await screen.findByRole('heading', { name: 'Preview Multiview' }, { timeout: 10000 })
    ).toBeTruthy();
    for (const label of [
      'Main Lyric — Output 1',
      'Main Lyric — Output 2',
      'Stage Confidence',
      'Countdown / Time',
      'Stream Lower-Third',
    ]) {
      expect(screen.getByRole('heading', { name: label })).toBeTruthy();
    }

    const streamFrame = screen.getByTitle('Stream Lower-Third');
    expect(streamFrame.tagName).toBe('IFRAME');
    expect(streamFrame.getAttribute('src')).toContain('stream');
  });
});
