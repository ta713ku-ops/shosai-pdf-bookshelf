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
};

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
  const [visible, setVisible] = useState(true);
  const standalone = isStandaloneDisplay();
  const [fullscreen, setFullscreen] = useState(() => isDocumentFullscreen());
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<GestureState | null>(null);
  const progressRef = useRef(onProgress); progressRef.current = onProgress;
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
  useEffect(() => { if (pdf) progressRef.current(page); }, [page, pdf]);
  useEffect(() => {
    const syncFullscreen = () => {
      setFullscreen(isDocumentFullscreen());
      if (!isDocumentFullscreen()) setVisible(true);
    };
    syncFullscreen();
    return addFullscreenChangeListener(syncFullscreen);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input, select, textarea')) return;
      if (event.key === 'Escape' && !isDocumentFullscreen()) onClose();
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); move((event.key === 'ArrowRight') === (book.direction === 'ltr') ? 1 : -1); }
      if (event.key === ' ') { event.preventDefault(); setVisible(value => !value); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [move, onClose, book.direction]);
  const toggleFullscreen = () => {
    if (isDocumentFullscreen()) void exitAppFullscreen();
    else void requestAppFullscreen().then(setFullscreen);
  };
  return <section className={`reader ${visible ? '' : 'reader-ui-hidden'}`} aria-label={`${book.title}を読む`}>
    <header className="reader-toolbar">
      <button onClick={onClose} aria-label="本棚に戻る">← 本棚</button><h1>{book.title}</h1>
      {!standalone && (canRequestFullscreen() || fullscreen) && <button onClick={toggleFullscreen} aria-label={fullscreen ? '全画面を解除' : '全画面で表示'}>{fullscreen ? '全画面解除' : '全画面'}</button>}
      <button onClick={() => setVisible(false)} aria-label="操作パネルを隠す">非表示</button>
    </header>
    <div className="reader-stage" ref={stageRef} onPointerDown={event => {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 1) gesture.current = {
        startX: event.clientX, startY: event.clientY,
        startScrollLeft: event.currentTarget.scrollLeft, startScrollTop: event.currentTarget.scrollTop,
        startDistance: 0, startZoom: zoom, pinching: false,
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
      }
    }} onPointerCancel={event => {
      pointers.current.delete(event.pointerId);
      if (!pointers.current.size) gesture.current = null;
    }} onPointerUp={event => {
      const currentGesture = gesture.current;
      const wasPinching = currentGesture?.pinching || pointers.current.size > 1;
      pointers.current.delete(event.pointerId);
      if (!pointers.current.size) gesture.current = null;
      if (!currentGesture || wasPinching || zoom > 1) return;
      const dx = event.clientX - currentGesture.startX; const dy = event.clientY - currentGesture.startY;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) move((dx < 0) === (book.direction === 'ltr') ? 1 : -1);
      else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        const bounds = event.currentTarget.getBoundingClientRect(); const x = (event.clientX - bounds.left) / bounds.width;
        if (x < .22) move(book.direction === 'rtl' ? 1 : -1);
        else if (x > .78) move(book.direction === 'rtl' ? -1 : 1);
        else setVisible(value => !value);
      }
    }} onWheel={event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(value => Math.min(2, Math.max(1, value - event.deltaY * .004)));
    }}>
      {error ? <div className="reader-state" role="alert"><h2>PDFを開けません</h2><p>{error}</p><button onClick={onClose}>本棚に戻る</button></div> : !pdf ? <p className="reader-state" role="status">本を開いています…</p> : <div className="reader-pages" style={{ flexDirection: book.direction === 'rtl' ? 'row-reverse' : 'row' }}>
        {pages.map(number => <PageCanvas key={number} pdf={pdf} number={number} width={Math.max(100, (size.width - 48) / (spread ? 2 : 1))} height={Math.max(100, size.height - 32)} zoom={zoom} />)}
      </div>}
    </div>
    {!visible && <button className="reader-show" onClick={() => setVisible(true)} aria-label="操作パネルを表示">操作</button>}
    <footer className="reader-controls">
      <div className="reader-paging"><button disabled={pages[0] <= 1 || !pdf} onClick={() => move(-1)} aria-label="前のページ">前へ</button>
        <label className="reader-page-input"><span className="reader-sr">ページ番号</span><input aria-label="ページ番号" type="number" min={1} max={count} value={page} onChange={event => setPage(clampPage(Number(event.target.value), count))} /><span>/ {count}</span></label>
        <button disabled={pages[pages.length - 1] >= count || !pdf} onClick={() => move(1)} aria-label="次のページ">次へ</button></div>
      <div className="reader-settings"><button disabled={zoom <= 1} aria-label="縮小" onClick={() => setZoom(value => Math.max(1, value - .25))}>−</button><button onClick={() => setZoom(1)} aria-label="表示倍率をリセット">{Math.round(zoom * 100)}%</button><button disabled={zoom >= 2} aria-label="拡大" onClick={() => setZoom(value => Math.min(2, value + .25))}>＋</button>
        <select aria-label="本の開き方向" value={book.direction} onChange={event => onDirectionChange(event.target.value as ReadingDirection)}><option value="rtl">右開き</option><option value="ltr">左開き</option></select></div>
    </footer>
  </section>;
}
