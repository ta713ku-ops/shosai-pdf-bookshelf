import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Reader, type ReaderBook } from './Reader';

const pdf = {
  numPages: 6,
  getPage: vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
  })),
};

vi.mock('../lib/pdf', () => ({
  getDocument: () => ({ promise: Promise.resolve(pdf), destroy: vi.fn() }),
}));

vi.mock('../lib/fullscreen', () => ({
  addFullscreenChangeListener: () => () => {},
  canRequestFullscreen: () => true,
  exitAppFullscreen: vi.fn(),
  isDocumentFullscreen: () => false,
  isStandaloneDisplay: () => false,
  requestAppFullscreen: vi.fn(async () => true),
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

class PointerEventMock extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'touch';
  }
}

const book: ReaderBook = {
  id: 'book-1',
  title: 'テストの本',
  file: { arrayBuffer: vi.fn(async () => new ArrayBuffer(8)) } as unknown as Blob,
  pageCount: 6,
  progress: 1,
  direction: 'ltr',
};

describe('Reader immersive controls and gestures', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal('PointerEvent', PointerEventMock);
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts distraction-free, reveals controls by center tap, then hides them', async () => {
    render(<Reader book={book} onClose={vi.fn()} onProgress={vi.fn()} onDirectionChange={vi.fn()} />);
    const reader = screen.getByRole('dialog', { name: 'テストの本を読む' });
    await waitFor(() => expect(screen.queryByText('本を開いています…')).not.toBeInTheDocument());
    expect(reader).toHaveClass('reader-ui-hidden');

    const stage = reader.querySelector('.reader-stage') as HTMLElement;
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 1000, top: 0, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 500, clientY: 400 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 500, clientY: 400 });
    expect(reader).not.toHaveClass('reader-ui-hidden');

    act(() => vi.advanceTimersByTime(4000));
    expect(reader).toHaveClass('reader-ui-hidden');
  });

  it('tracks a horizontal drag and commits the next real page', async () => {
    const onProgress = vi.fn();
    render(<Reader book={book} onClose={vi.fn()} onProgress={onProgress} onDirectionChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('本を開いています…')).not.toBeInTheDocument());
    const stage = screen.getByRole('dialog').querySelector('.reader-stage') as HTMLElement;
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 800, clientY: 400 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 560, clientY: 402 });
    expect(stage.querySelector('.reader-pages')).toHaveClass('is-dragging');
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 420, clientY: 402 });
    act(() => vi.advanceTimersByTime(190));
    await waitFor(() => expect(onProgress).toHaveBeenCalledWith(3));
  });
});
