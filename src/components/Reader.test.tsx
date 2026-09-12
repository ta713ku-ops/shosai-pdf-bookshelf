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
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: vi.fn(() => ({ drawImage: vi.fn() })) });
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
    const curl = stage.querySelector('.reader-turn-layer');
    expect(curl).toHaveAttribute('data-turn-direction', 'forward');
    expect(curl).toHaveAttribute('data-turn-side', 'right');
    expect(curl?.querySelector('.reader-turn-front')).toBeInTheDocument();
    expect(curl?.querySelector('.reader-turn-back')).toBeInTheDocument();
    expect(curl?.querySelector('.reader-turn-underlay')).toBeInTheDocument();
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 420, clientY: 402 });
    expect(stage.querySelector('.reader-pages')).toHaveClass('is-settling');
    act(() => vi.advanceTimersByTime(1200));
    await waitFor(() => expect(onProgress).toHaveBeenCalledWith(2));
    expect(stage.querySelector('.reader-pages')).toHaveAttribute('data-visible-pages', '2,3');
  });

  it('shows only the cover before the first body spread in landscape', async () => {
    render(<Reader book={book} onClose={vi.fn()} onProgress={vi.fn()} onDirectionChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('本を開いています…')).not.toBeInTheDocument());
    const pages = screen.getByRole('dialog').querySelector('.reader-pages') as HTMLElement;
    expect(pages).toHaveAttribute('data-visible-pages', '1');
    expect(pages.querySelectorAll(':scope > .reader-page')).toHaveLength(1);
    expect(pages.querySelector('canvas[aria-label="1ページ"]')).toBeInTheDocument();
    expect(pages.querySelector('canvas[aria-label="2ページ"]')).not.toBeInTheDocument();
    expect(pages.querySelector('.reader-page-spacer')).toBeInTheDocument();
  });

  it('mirrors the physical curl for a right-opening book', async () => {
    render(<Reader book={{ ...book, direction: 'rtl' }} onClose={vi.fn()} onProgress={vi.fn()} onDirectionChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('本を開いています…')).not.toBeInTheDocument());
    const stage = screen.getByRole('dialog').querySelector('.reader-stage') as HTMLElement;
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 220, clientY: 400 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 520, clientY: 402 });
    const curl = stage.querySelector('.reader-turn-layer');
    expect(curl).toHaveAttribute('data-turn-direction', 'forward');
    expect(curl).toHaveAttribute('data-turn-side', 'left');
  });

  it('uses one binding axis for both directions in portrait', async () => {
    vi.stubGlobal('innerWidth', 820);
    vi.stubGlobal('innerHeight', 1180);
    render(<Reader book={{ ...book, progress: 2, direction: 'ltr' }} onClose={vi.fn()} onProgress={vi.fn()} onDirectionChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('本を開いています…')).not.toBeInTheDocument());
    const stage = screen.getByRole('dialog').querySelector('.reader-stage') as HTMLElement;

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 760, clientY: 560 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 510, clientY: 560 });
    const forward = stage.querySelector('.reader-turn-layer');
    expect(forward).toHaveAttribute('data-turn-direction', 'forward');
    expect(forward).toHaveAttribute('data-turn-axis', 'left');
    expect(forward).toHaveClass('is-single');
    fireEvent.pointerCancel(stage, { pointerId: 1 });
    act(() => vi.advanceTimersByTime(1200));

    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 180, clientY: 560 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 460, clientY: 560 });
    const backward = stage.querySelector('.reader-turn-layer');
    expect(backward).toHaveAttribute('data-turn-direction', 'backward');
    expect(backward).toHaveAttribute('data-turn-axis', 'left');
    expect(backward).toHaveClass('is-single');
    expect(backward).toHaveClass('is-portrait-backward');
    const backwardAngle = parseFloat((backward as HTMLElement).style.getPropertyValue('--reader-curl-angle'));
    expect(Math.abs(backwardAngle)).toBeGreaterThan(0);
    expect(Math.abs(backwardAngle)).toBeLessThan(82);
    expect(backward?.querySelector('.reader-turn-front canvas[aria-label="1ページ"]')).toBeInTheDocument();
    expect(backward?.querySelector('.reader-turn-back canvas[aria-label="2ページ"]')).toBeInTheDocument();
    expect(backward?.querySelector('.reader-turn-underlay canvas')).not.toBeInTheDocument();
  });

  it('mirrors the incoming portrait back turn for a right-opening book', async () => {
    vi.stubGlobal('innerWidth', 820);
    vi.stubGlobal('innerHeight', 1180);
    render(<Reader book={{ ...book, progress: 2, direction: 'rtl' }} onClose={vi.fn()} onProgress={vi.fn()} onDirectionChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('本を開いています…')).not.toBeInTheDocument());
    const stage = screen.getByRole('dialog').querySelector('.reader-stage') as HTMLElement;

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 640, clientY: 560 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 360, clientY: 560 });
    const backward = stage.querySelector('.reader-turn-layer') as HTMLElement;

    expect(backward).toHaveAttribute('data-turn-direction', 'backward');
    expect(backward).toHaveAttribute('data-turn-side', 'left');
    expect(backward).toHaveAttribute('data-turn-axis', 'right');
    expect(parseFloat(backward.style.getPropertyValue('--reader-curl-angle'))).toBeLessThan(0);
    expect(backward.querySelector('.reader-turn-front canvas[aria-label="1ページ"]')).toBeInTheDocument();
    expect(backward.querySelector('.reader-turn-underlay canvas')).not.toBeInTheDocument();
  });

  it.each([
    { direction: 'rtl' as const, startX: 780, moveX: 560, endX: 390 },
    { direction: 'ltr' as const, startX: 200, moveX: 430, endX: 650 },
  ])('turns one cover leaf without rendering a duplicate underneath in landscape ($direction)', async ({ direction, startX, moveX, endX }) => {
    const onProgress = vi.fn();
    render(<Reader book={{ ...book, progress: 2, direction }} onClose={vi.fn()} onProgress={onProgress} onDirectionChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('本を開いています…')).not.toBeInTheDocument());
    const stage = screen.getByRole('dialog').querySelector('.reader-stage') as HTMLElement;

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: startX, clientY: 430 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: moveX, clientY: 430 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: endX, clientY: 430 });

    const curl = stage.querySelector('.reader-turn-layer');
    expect(curl).toHaveClass('is-target-cover');
    expect(curl?.querySelector('.reader-turn-back canvas[aria-label="1ページ"]')).toBeInTheDocument();
    expect(curl?.querySelector('.reader-turn-underlay canvas')).not.toBeInTheDocument();
    expect(curl?.querySelectorAll('canvas[aria-label="1ページ"]')).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1200));
    await waitFor(() => expect(onProgress).toHaveBeenLastCalledWith(1));
    const pages = stage.querySelector('.reader-pages') as HTMLElement;
    expect(pages).toHaveAttribute('data-visible-pages', '1');
    expect(pages.querySelectorAll(':scope > .reader-page')).toHaveLength(1);
  });

  it('curls the current sheet back across the book when returning to the previous spread', async () => {
    const onProgress = vi.fn();
    render(<Reader book={{ ...book, progress: 4, direction: 'rtl' }} onClose={vi.fn()} onProgress={onProgress} onDirectionChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('本を開いています…')).not.toBeInTheDocument());
    const stage = screen.getByRole('dialog').querySelector('.reader-stage') as HTMLElement;
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 820, clientY: 430 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 590, clientY: 426 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 410, clientY: 424 });
    const curl = stage.querySelector('.reader-turn-layer');
    expect(curl).toHaveAttribute('data-turn-direction', 'backward');
    expect(curl).toHaveAttribute('data-turn-side', 'right');
    expect(curl).toHaveAttribute('data-turn-axis', 'left');
    expect(curl).toHaveClass('is-spread');
    expect(curl?.querySelector('.reader-turn-front canvas[aria-label="4ページ"]')).toBeInTheDocument();
    expect(curl?.querySelector('.reader-turn-back canvas[aria-label="3ページ"]')).toBeInTheDocument();
    expect(curl?.querySelector('.reader-turn-underlay canvas[aria-label="2ページ"]')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(600));
    expect(stage.querySelector('.reader-turn-layer')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(600));
    await waitFor(() => expect(onProgress).toHaveBeenLastCalledWith(2));
    expect(stage.querySelector('.reader-pages')).toHaveAttribute('data-visible-pages', '2,3');
  });

  it('ignores unmatched pointer releases while a rapid-tap page turn is settling', async () => {
    const onProgress = vi.fn();
    render(<Reader book={book} onClose={vi.fn()} onProgress={onProgress} onDirectionChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('本を開いています…')).not.toBeInTheDocument());
    const stage = screen.getByRole('dialog').querySelector('.reader-stage') as HTMLElement;
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 1000, top: 0, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 900, clientY: 400 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 900, clientY: 400 });
    for (let pointerId = 2; pointerId <= 7; pointerId += 1) {
      fireEvent.pointerDown(stage, { pointerId, clientX: 900, clientY: 400 });
      fireEvent.pointerUp(stage, { pointerId, clientX: 900, clientY: 400 });
    }
    expect(stage.querySelector('.reader-pages')).toHaveClass('is-settling');
    act(() => vi.advanceTimersByTime(1234));
    await waitFor(() => expect(onProgress).toHaveBeenLastCalledWith(2));
    expect(stage.querySelector('.reader-pages')).toHaveAttribute('data-visible-pages', '2,3');
    expect(stage.querySelector('.reader-turn-layer')).not.toBeInTheDocument();
  });

  it('turns immediately without a curl when reduced motion is requested', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const onProgress = vi.fn();
    render(<Reader book={book} onClose={vi.fn()} onProgress={onProgress} onDirectionChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('本を開いています…')).not.toBeInTheDocument());
    const stage = screen.getByRole('dialog').querySelector('.reader-stage') as HTMLElement;
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 800, clientY: 400 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 520, clientY: 402 });
    expect(stage.querySelector('.reader-turn-layer')).not.toBeInTheDocument();
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 420, clientY: 402 });
    await waitFor(() => expect(onProgress).toHaveBeenCalledWith(2));
  });
});
