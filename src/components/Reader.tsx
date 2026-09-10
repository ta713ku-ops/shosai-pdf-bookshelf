import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, type PDFDocumentProxy } from '../lib/pdf';
import { clampPage, spreadPages, turnPage, type ReadingDirection } from '../lib/reading';
import { addFullscreenChangeListener, canRequestFullscreen, exitAppFullscreen, isDocumentFullscreen, isStandaloneDisplay, requestAppFullscreen } from '../lib/fullscreen';
import './Reader.css';

export interface ReaderBook { id: string; title: string; file: Blob; pageCount: number; progress: number; direction: ReadingDirection }
export interface ReaderProps { book: ReaderBook; onClose: () => void; onProgress: (page: number) => void; onDirectionChange: (direction: ReadingDirection) => void }

type GestureState = {
  startX: number; startY: number; startScrollLeft: number; startScrollTop: number;
  startDistance: number; startZoom: number; pinching: boolean;
  lastX: number; lastTime: number; velocityX: number;
};

const CONTROLS_TIMEOUT_MS = 4000;
const TURN_SETTLE_MS = 190;

function pointerDistance(points: Map<number, { x: number; y: number }>) {
  const [a, b] = Array.from(points.values());
  return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
}

function PageCanvas({ pdf, number, width, height, zoom }: { pdf: PDFDocumentProxy; number: number; width: number; height: number; zoom: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    setReady(false); setError(false);
    void pdf.getPage(number).then(page => {
      if (cancelled || !canvasRef.current) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(width / base.width, height / base.height) * zoom;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * ratio });
      const canvas = canvasRef.current;
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${viewport.width / ratio}px`; canvas.style.height = `${viewport.height / ratio}px`;
      render = page.render({ canvas, viewport });
      return render.promise;
    }).then(() => { if (!cancelled) setReady(true); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, number, width, height, zoom]);
  return <div className="reader-page" aria-busy={!ready && !error}>
    <canvas ref={canvasRef} aria-label={`${number}ページ`} role="img" style={{ visibility: ready ? 'visible' : 'hidden' }} />
    {!ready && <span className="reader-page-message" role={error ? 'alert' : 'status'}>{error ? 'ページを表示できませんでした' : '読み込み中…'}</span>}
  </div>;
}

export function Reader({ book, onClose, onProgress, onDirectionChange }: ReaderProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(book.progress || 1);
  const [zoom, setZoom] = useState(1);
  const [visible, setVisible] = useState(false);
  const standalone = isStandaloneDisplay();
  const [fullscreen, setFullscreen] = useState(() => isDocumentFullscreen());
  const wasFullscreen = useRef(isDocumentFullscreen());
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const readerRef = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<GestureState | null>(null);
  const controlsTimer = useRef<number | null>(null);
  const turnTimer = useRef<number | null>(null);
  const progressRef = useRef(onProgress); progressRef.current = onProgress;
  const clearControlsTimer = useCallback(() => {
    if (controlsTimer.current !== null) window.clearTimeout(controlsTimer.current);
    controlsTimer.current = null;
  }, []);
  const hideControls = useCallback(() => {
    clearControlsTimer();
    setVisible(false);
  }, [clearControlsTimer]);
  const showControls = useCallback((autoHide = true) => {
    clearControlsTimer();
    setVisible(true);
    if (autoHide) controlsTimer.current = window.setTimeout(() => {
      const focused = document.activeElement;
      if (focused instanceof Element && (controlsRef.current?.contains(focused) || focused.closest('.reader-toolbar'))) return;
      setVisible(false);
    }, CONTROLS_TIMEOUT_MS);
  }, [clearControlsTimer]);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    readerRef.current?.focus({ preventScroll: true });
    return () => {
      clearControlsTimer();
      if (turnTimer.current !== null) window.clearTimeout(turnTimer.current);
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [clearControlsTimer]);
  useEffect(() => {
    let active = true;
    let task: ReturnType<typeof getDocument> | undefined;
    setPdf(null); setError(''); setPage(book.progress || 1);
    void book.file.arrayBuffer().then(data => {
      if (!active) return;
      task = getDocument({ data: new Uint8Array(data) });
      return task.promise;
    }).then(document => { if (active && document) { setPdf(document); setPage(value => clampPage(value, document.numPages)); } }).catch(reason => {
      if (active) setError(reason?.name === 'PasswordException' ? 'パスワード付きのPDFには対応していません。解除したPDFを追加してください。' : 'PDFを開けませんでした。ファイルが破損している可能性があります。');
    });
    return () => { active = false; void task?.destroy(); };
  }, [book.id, book.file]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect; setSize({ width: rect.width, height: rect.height });
    });
    if (stageRef.current) observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);
  const spread = size.width > size.height;
  const count = pdf?.numPages || book.pageCount || 1;
  const pages = spreadPages(page, count, spread);
  const move = useCallback((delta: number) => setPage(current => turnPage(current, count, spread, delta)), [count, spread]);
  const directionForDrag = useCallback((dx: number) => ((dx < 0) === (book.direction === 'ltr') ? 1 : -1), [book.direction]);
  const canMove = useCallback((delta: number) => delta > 0 ? pages[pages.length - 1] < count : pages[0] > 1, [count, pages]);
  const resetDrag = useCallback(() => {
    setDragging(false);
    setSettling(true);
    setDragOffset(0);
    if (turnTimer.current !== null) window.clearTimeout(turnTimer.current);
    turnTimer.current = window.setTimeout(() => setSettling(false), TURN_SETTLE_MS);
  }, []);
  const completeDrag = useCallback((dx: number, delta: number) => {
    setDragging(false);
    setSettling(true);
    setDragOffset(dx < 0 ? -Math.max(size.width, 320) : Math.max(size.width, 320));
    if (turnTimer.current !== null) window.clearTimeout(turnTimer.current);
    turnTimer.current = window.setTimeout(() => {
      move(delta);
      setSettling(false);
      setDragOffset(0);
    }, TURN_SETTLE_MS);
  }, [move, size.width]);
  useEffect(() => { if (pdf) progressRef.current(page); }, [page, pdf]);
  useEffect(() => {
    const syncFullscreen = () => {
      const nextFullscreen = isDocumentFullscreen();
      setFullscreen(nextFullscreen);
      if (wasFullscreen.current && !nextFullscreen) showControls();
      wasFullscreen.current = nextFullscreen;
    };
    syncFullscreen();
    return addFullscreenChangeListener(syncFullscreen);
  }, [showControls]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isDocumentFullscreen()) onClose();
      if ((event.target as HTMLElement).matches('input, select, textarea, button')) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); showControls(false); move((event.key === 'ArrowRight') === (book.direction === 'ltr') ? 1 : -1); }
      if (event.key === ' ') { event.preventDefault(); visible ? hideControls() : showControls(false); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [move, onClose, book.direction, visible, hideControls, showControls]);
  const toggleFullscreen = () => {
    if (isDocumentFullscreen()) void exitAppFullscreen();
    else void requestAppFullscreen().then(setFullscreen);
  };
  return <section ref={readerRef} tabIndex={-1} role="dialog" aria-modal="true" className={`reader ${visible ? '' : 'reader-ui-hidden'}`} aria-label={`${book.title}を読む`}>
    <button className="reader-accessibility-toggle" onFocus={() => showControls(false)} onClick={() => showControls(false)}>読書操作を表示</button>
    <header className="reader-toolbar" onPointerDownCapture={() => showControls(false)} onFocusCapture={() => showControls(false)}>
      <button onClick={onClose} aria-label="本棚に戻る">← 本棚</button><h1>{book.title}</h1>
      {!standalone && (canRequestFullscreen() || fullscreen) && <button onClick={toggleFullscreen} aria-label={fullscreen ? '全画面を解除' : '全画面で表示'}>{fullscreen ? '全画面解除' : '全画面'}</button>}
      <button onClick={hideControls} aria-label="操作パネルを隠す">非表示</button>
    </header>
    <div className="reader-stage" ref={stageRef} onPointerDown={event => {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 1) gesture.current = {
        startX: event.clientX, startY: event.clientY,
        startScrollLeft: event.currentTarget.scrollLeft, startScrollTop: event.currentTarget.scrollTop,
        startDistance: 0, startZoom: zoom, pinching: false,
        lastX: event.clientX, lastTime: performance.now(), velocityX: 0,
      };
      if (pointers.current.size === 2 && gesture.current) {
        gesture.current.pinching = true;
        gesture.current.startDistance = pointerDistance(pointers.current);
        gesture.current.startZoom = zoom;
      }
    }} onPointerMove={event => {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const currentGesture = gesture.current;
      if (!currentGesture) return;
      if (pointers.current.size >= 2 && currentGesture.startDistance > 0) {
        event.preventDefault();
        const nextZoom = currentGesture.startZoom * pointerDistance(pointers.current) / currentGesture.startDistance;
        setZoom(Math.min(2, Math.max(1, Math.round(nextZoom * 20) / 20)));
      } else if (zoom > 1 && event.pointerType !== 'mouse') {
        event.preventDefault();
        event.currentTarget.scrollLeft = currentGesture.startScrollLeft - (event.clientX - currentGesture.startX);
        event.currentTarget.scrollTop = currentGesture.startScrollTop - (event.clientY - currentGesture.startY);
      } else if (pointers.current.size === 1) {
        const dx = event.clientX - currentGesture.startX;
        const dy = event.clientY - currentGesture.startY;
        const now = performance.now();
        const elapsed = Math.max(1, now - currentGesture.lastTime);
        currentGesture.velocityX = (event.clientX - currentGesture.lastX) / elapsed;
        currentGesture.lastX = event.clientX;
        currentGesture.lastTime = now;
        if (Math.abs(dx) > 5 && Math.abs(dx) > Math.abs(dy) * .85) {
          event.preventDefault();
          const resisted = canMove(directionForDrag(dx)) ? dx : dx * .24;
          setDragging(true);
          setSettling(false);
          setDragOffset(resisted);
        }
      }
    }} onPointerCancel={event => {
      pointers.current.delete(event.pointerId);
      if (!pointers.current.size) { gesture.current = null; resetDrag(); }
    }} onPointerUp={event => {
      const currentGesture = gesture.current;
      const wasPinching = currentGesture?.pinching || pointers.current.size > 1;
      pointers.current.delete(event.pointerId);
      if (!pointers.current.size) gesture.current = null;
      if (!currentGesture || wasPinching || zoom > 1) { resetDrag(); return; }
      const dx = event.clientX - currentGesture.startX; const dy = event.clientY - currentGesture.startY;
      const sinceLastMove = performance.now() - currentGesture.lastTime;
      const releaseVelocity = sinceLastMove <= 120 ? currentGesture.velocityX : 0;
      const delta = directionForDrag(dx || releaseVelocity);
      const shouldTurn = Math.abs(dx) > Math.max(56, size.width * .14) || Math.abs(releaseVelocity) > .55;
      if (shouldTurn && Math.abs(dx) > Math.abs(dy) * 1.1 && canMove(delta)) completeDrag(dx || releaseVelocity, delta);
      else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        const bounds = event.currentTarget.getBoundingClientRect(); const x = (event.clientX - bounds.left) / bounds.width;
        if (x < .22) move(book.direction === 'rtl' ? 1 : -1);
        else if (x > .78) move(book.direction === 'rtl' ? -1 : 1);
        else visible ? hideControls() : showControls();
      } else resetDrag();
    }} onWheel={event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(value => Math.min(2, Math.max(1, value - event.deltaY * .004)));
    }}>
      {error ? <div className="reader-state" role="alert"><h2>PDFを開けません</h2><p>{error}</p><button onClick={onClose}>本棚に戻る</button></div> : !pdf ? <p className="reader-state" role="status">本を開いています…</p> : <div className={`reader-pages ${dragging ? 'is-dragging' : ''} ${settling ? 'is-settling' : ''}`} style={{ flexDirection: book.direction === 'rtl' ? 'row-reverse' : 'row', '--reader-drag-x': `${dragOffset}px` } as React.CSSProperties}>
        {pages.map(number => <PageCanvas key={number} pdf={pdf} number={number} width={Math.max(100, (size.width - 18) / (spread ? 2 : 1))} height={Math.max(100, size.height - 16)} zoom={zoom} />)}
      </div>}
    </div>
    <footer ref={controlsRef} className="reader-controls" onPointerDownCapture={() => showControls(false)} onFocusCapture={() => showControls(false)}>
      <div className="reader-paging"><button disabled={pages[0] <= 1 || !pdf} onClick={() => move(-1)} aria-label="前のページ">前へ</button>
        <label className="reader-page-input"><span className="reader-sr">ページ番号</span><input aria-label="ページ番号" type="number" min={1} max={count} value={page} onChange={event => setPage(clampPage(Number(event.target.value), count))} /><span>/ {count}</span></label>
        <button disabled={pages[pages.length - 1] >= count || !pdf} onClick={() => move(1)} aria-label="次のページ">次へ</button></div>
      <div className="reader-settings"><button disabled={zoom <= 1} aria-label="縮小" onClick={() => setZoom(value => Math.max(1, value - .25))}>−</button><button onClick={() => setZoom(1)} aria-label="表示倍率をリセット">{Math.round(zoom * 100)}%</button><button disabled={zoom >= 2} aria-label="拡大" onClick={() => setZoom(value => Math.min(2, value + .25))}>＋</button>
        <select aria-label="本の開き方向" value={book.direction} onChange={event => onDirectionChange(event.target.value as ReadingDirection)}><option value="rtl">右開き</option><option value="ltr">左開き</option></select></div>
    </footer>
  </section>;
}
