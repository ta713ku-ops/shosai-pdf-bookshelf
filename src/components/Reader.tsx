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

type TurnState = {
  delta: -1 | 1;
  progress: number;
  touchY: number;
  phase: 'dragging' | 'settling';
};

const CONTROLS_TIMEOUT_MS = 4000;
const TURN_SETTLE_MS = 720;
const MAX_CACHED_PAGES = 8;

type CachedPage = { canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number };
const pageRenderCache = new WeakMap<PDFDocumentProxy, Map<string, CachedPage>>();

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
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const cacheKey = `${number}:${Math.round(width)}:${Math.round(height)}:${Math.round(zoom * 100)}:${ratio}`;
    let cache = pageRenderCache.get(pdf);
    if (!cache) { cache = new Map(); pageRenderCache.set(pdf, cache); }
    const cached = cache.get(cacheKey);
    if (cached && canvasRef.current) {
      const canvas = canvasRef.current;
      canvas.width = cached.canvas.width; canvas.height = cached.canvas.height;
      canvas.style.width = `${cached.cssWidth}px`; canvas.style.height = `${cached.cssHeight}px`;
      const context = canvas.getContext('2d');
      context?.drawImage(cached.canvas, 0, 0);
      setReady(true);
      return;
    }
    void pdf.getPage(number).then(page => {
      if (cancelled || !canvasRef.current) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(width / base.width, height / base.height) * zoom;
      const viewport = page.getViewport({ scale: scale * ratio });
      const canvas = canvasRef.current;
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${viewport.width / ratio}px`; canvas.style.height = `${viewport.height / ratio}px`;
      render = page.render({ canvas, viewport });
      return render.promise;
    }).then(() => {
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const snapshot = document.createElement('canvas');
      snapshot.width = canvas.width; snapshot.height = canvas.height;
      snapshot.getContext('2d')?.drawImage(canvas, 0, 0);
      cache.set(cacheKey, { canvas: snapshot, cssWidth: canvas.width / ratio, cssHeight: canvas.height / ratio });
      while (cache.size > MAX_CACHED_PAGES) cache.delete(cache.keys().next().value as string);
      setReady(true);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, number, width, height, zoom]);
  return <div className="reader-page" aria-busy={!ready && !error}>
    <canvas ref={canvasRef} aria-label={`${number}ページ`} role="img" style={{ visibility: ready ? 'visible' : 'hidden' }} />
    {!ready && <span className="reader-page-message" role={error ? 'alert' : 'status'}>{error ? 'ページを表示できませんでした' : '読み込み中…'}</span>}
  </div>;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

function PageCurl({ pdf, page, count, spread, direction, turn, width, height, zoom }: {
  pdf: PDFDocumentProxy; page: number; count: number; spread: boolean; direction: ReadingDirection;
  turn: TurnState; width: number; height: number; zoom: number;
}) {
  const currentPages = spreadPages(page, count, spread);
  const targetPages = spreadPages(turnPage(page, count, spread, turn.delta), count, spread);
  const side = ((turn.delta > 0) === (direction === 'ltr')) ? 'right' : 'left';
  const currentEdge = currentPages[currentPages.length - 1];
  const targetNear = targetPages[0];
  const frontPage = turn.delta > 0 ? currentEdge : targetNear;
  const backPage = turn.delta > 0 ? targetNear : currentEdge;
  const underPage = turn.delta > 0 ? targetPages[targetPages.length - 1] : currentPages[0];
  const travel = turn.delta > 0 ? turn.progress : 1 - turn.progress;
  const turnSign = side === 'right' ? -1 : 1;
  const curve = Math.sin(Math.PI * turn.progress);
  const style = {
    '--reader-curl-angle': `${turnSign * travel * 180}deg`,
    '--reader-curl-progress': turn.progress,
    '--reader-curl-curve': curve,
    '--reader-curl-touch-y': `${turn.touchY * 100}%`,
    '--reader-curl-lift': `${(turn.touchY - .5) * curve * 5.5}deg`,
  } as React.CSSProperties;

  return <div
    className={`reader-turn-layer ${spread && currentPages.length > 1 ? 'is-spread' : 'is-single'} is-${side} is-${turn.delta > 0 ? 'forward' : 'backward'} is-${turn.phase}`}
    data-turn-side={side}
    data-turn-direction={turn.delta > 0 ? 'forward' : 'backward'}
    aria-hidden="true"
    style={style}
  >
    <div className="reader-turn-underlay">
      <PageCanvas pdf={pdf} number={underPage} width={width} height={height} zoom={zoom} />
    </div>
    <div className="reader-turn-cast-shadow" />
    <div className="reader-turn-sheet">
      <div className="reader-turn-face reader-turn-front">
        <PageCanvas pdf={pdf} number={frontPage} width={width} height={height} zoom={zoom} />
        <span className="reader-turn-ink-shadow" />
      </div>
      <div className="reader-turn-face reader-turn-back">
        <PageCanvas pdf={pdf} number={backPage} width={width} height={height} zoom={zoom} />
        <span className="reader-turn-paper-glow" />
      </div>
      <span className="reader-turn-fold" />
    </div>
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
  const [turn, setTurn] = useState<TurnState | null>(null);
  const reducedMotion = useReducedMotion();
  const readerRef = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<GestureState | null>(null);
  const controlsTimer = useRef<number | null>(null);
  const turnTimer = useRef<number | null>(null);
  const turnFrame = useRef<number | null>(null);
  const turnRef = useRef<TurnState | null>(null);
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
      if (turnFrame.current !== null) window.cancelAnimationFrame(turnFrame.current);
      turnRef.current = null;
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
  const directionForDrag = useCallback((dx: number): -1 | 1 => ((dx < 0) === (book.direction === 'ltr') ? 1 : -1), [book.direction]);
  const canMove = useCallback((delta: number) => delta > 0 ? pages[pages.length - 1] < count : pages[0] > 1, [count, pages]);
  const finishTurn = useCallback((commit: boolean) => {
    const activeTurn = turnRef.current;
    if (!activeTurn) return;
    const delta = activeTurn.delta;
    if (turnTimer.current !== null) window.clearTimeout(turnTimer.current);
    if (reducedMotion) {
      if (commit) move(delta);
      turnRef.current = null;
      setTurn(null);
      return;
    }
    const settlingTurn = { ...activeTurn, phase: 'settling' as const, progress: commit ? 1 : 0 };
    turnRef.current = settlingTurn;
    setTurn(settlingTurn);
    turnTimer.current = window.setTimeout(() => {
      if (commit) move(delta);
      turnRef.current = null;
      setTurn(null);
      turnTimer.current = null;
    }, TURN_SETTLE_MS);
  }, [move, reducedMotion]);
  const requestTurn = useCallback((delta: -1 | 1) => {
    if (turnRef.current || !canMove(delta)) return;
    if (turnTimer.current !== null) window.clearTimeout(turnTimer.current);
    if (turnFrame.current !== null) window.cancelAnimationFrame(turnFrame.current);
    if (reducedMotion) { move(delta); return; }
    const initialTurn: TurnState = { delta, progress: 0, touchY: .5, phase: 'settling' };
    turnRef.current = initialTurn;
    setTurn(initialTurn);
    turnFrame.current = window.requestAnimationFrame(() => {
      turnFrame.current = window.requestAnimationFrame(() => {
        const current = turnRef.current;
        if (!current || current.delta !== delta) return;
        const completedTurn = { ...current, progress: 1 };
        turnRef.current = completedTurn;
        setTurn(completedTurn);
      });
    });
    if (turnTimer.current !== null) window.clearTimeout(turnTimer.current);
    turnTimer.current = window.setTimeout(() => {
      move(delta);
      turnRef.current = null;
      setTurn(null);
      turnTimer.current = null;
    }, TURN_SETTLE_MS + 34);
  }, [canMove, move, reducedMotion]);
  useEffect(() => {
    if (turnTimer.current !== null) window.clearTimeout(turnTimer.current);
    if (turnFrame.current !== null) window.cancelAnimationFrame(turnFrame.current);
    turnTimer.current = null;
    turnFrame.current = null;
    turnRef.current = null;
    setTurn(null);
  }, [spread, book.direction]);
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
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); showControls(false); requestTurn((event.key === 'ArrowRight') === (book.direction === 'ltr') ? 1 : -1); }
      if (event.key === ' ') { event.preventDefault(); visible ? hideControls() : showControls(false); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [requestTurn, onClose, book.direction, visible, hideControls, showControls]);
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
      if (turnRef.current?.phase === 'settling') return;
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
        if (turnRef.current) finishTurn(false);
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
          const delta = directionForDrag(dx);
          const distance = Math.max(120, size.width * (spread && pages.length > 1 ? .48 : .82));
          const progress = Math.min(canMove(delta) ? .985 : .14, Math.abs(dx) / distance);
          const bounds = event.currentTarget.getBoundingClientRect();
          const touchY = Math.min(.9, Math.max(.1, (event.clientY - bounds.top) / Math.max(1, bounds.height)));
          if (!reducedMotion) {
            const draggingTurn: TurnState = { delta, progress, touchY, phase: 'dragging' };
            turnRef.current = draggingTurn;
            setTurn(draggingTurn);
          }
        }
      }
    }} onPointerCancel={event => {
      pointers.current.delete(event.pointerId);
      if (!pointers.current.size) { gesture.current = null; finishTurn(false); }
    }} onPointerUp={event => {
      const currentGesture = gesture.current;
      const wasPinching = currentGesture?.pinching || pointers.current.size > 1;
      pointers.current.delete(event.pointerId);
      if (!pointers.current.size) gesture.current = null;
      if (!currentGesture || wasPinching || zoom > 1) { finishTurn(false); return; }
      const dx = event.clientX - currentGesture.startX; const dy = event.clientY - currentGesture.startY;
      const sinceLastMove = performance.now() - currentGesture.lastTime;
      const releaseVelocity = sinceLastMove <= 120 ? currentGesture.velocityX : 0;
      const delta = directionForDrag(dx || releaseVelocity);
      const shouldTurn = Math.abs(dx) > Math.max(56, size.width * .14) || Math.abs(releaseVelocity) > .55;
      if (shouldTurn && Math.abs(dx) > Math.abs(dy) * 1.1 && canMove(delta)) {
        if (reducedMotion) move(delta);
        else finishTurn(true);
      }
      else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        const bounds = event.currentTarget.getBoundingClientRect(); const x = (event.clientX - bounds.left) / bounds.width;
        if (x < .22) requestTurn(book.direction === 'rtl' ? 1 : -1);
        else if (x > .78) requestTurn(book.direction === 'rtl' ? -1 : 1);
        else visible ? hideControls() : showControls();
      } else finishTurn(false);
    }} onWheel={event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(value => Math.min(2, Math.max(1, value - event.deltaY * .004)));
    }}>
      {error ? <div className="reader-state" role="alert"><h2>PDFを開けません</h2><p>{error}</p><button onClick={onClose}>本棚に戻る</button></div> : !pdf ? <p className="reader-state" role="status">本を開いています…</p> : <div className={`reader-pages ${turn?.phase === 'dragging' ? 'is-dragging' : ''} ${turn?.phase === 'settling' ? 'is-settling' : ''}`} data-current-page={page} data-visible-pages={pages.join(',')} style={{ flexDirection: book.direction === 'rtl' ? 'row-reverse' : 'row' }}>
        {pages.map(number => <PageCanvas key={number} pdf={pdf} number={number} width={Math.max(100, (size.width - 18) / (spread ? 2 : 1))} height={Math.max(100, size.height - 16)} zoom={zoom} />)}
        {turn && <PageCurl pdf={pdf} page={page} count={count} spread={spread} direction={book.direction} turn={turn} width={Math.max(100, (size.width - 18) / (spread ? 2 : 1))} height={Math.max(100, size.height - 16)} zoom={zoom} />}
      </div>}
    </div>
    <footer ref={controlsRef} className="reader-controls" onPointerDownCapture={() => showControls(false)} onFocusCapture={() => showControls(false)}>
      <div className="reader-paging"><button disabled={pages[0] <= 1 || !pdf} onClick={() => requestTurn(-1)} aria-label="前のページ">前へ</button>
        <label className="reader-page-input"><span className="reader-sr">ページ番号</span><input aria-label="ページ番号" type="number" min={1} max={count} value={page} onChange={event => setPage(clampPage(Number(event.target.value), count))} /><span>/ {count}</span></label>
        <button disabled={pages[pages.length - 1] >= count || !pdf} onClick={() => requestTurn(1)} aria-label="次のページ">次へ</button></div>
      <div className="reader-settings"><button disabled={zoom <= 1} aria-label="縮小" onClick={() => setZoom(value => Math.max(1, value - .25))}>−</button><button onClick={() => setZoom(1)} aria-label="表示倍率をリセット">{Math.round(zoom * 100)}%</button><button disabled={zoom >= 2} aria-label="拡大" onClick={() => setZoom(value => Math.min(2, value + .25))}>＋</button>
        <select aria-label="本の開き方向" value={book.direction} onChange={event => onDirectionChange(event.target.value as ReadingDirection)}><option value="rtl">右開き</option><option value="ltr">左開き</option></select></div>
    </footer>
  </section>;
}
