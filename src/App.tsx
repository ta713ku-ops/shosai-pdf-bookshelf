import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { ReaderBook } from './components/Reader'
import {
  deleteBook,
  deleteShelf,
  getBookPdf,
  listBooks,
  listShelves,
  saveBook,
  saveShelf,
  updateBook,
} from './data/libraryDb'
import type { BookRecord, BookUpdate, ShelfRecord } from './domain/books'
import { calculateShelfLayout, clampShelfPage, compareBooksByAddedOrder, pageForAnchor, paginate, type ShelfLayout } from './lib/bookshelf'
import { exitAppFullscreen } from './lib/fullscreen'

type ShelfFilter = 'all' | 'unfiled' | string

const Reader = lazy(() => import('./components/Reader').then((module) => ({ default: module.Reader })))

interface ActiveBook extends ReaderBook {
  record: BookRecord
}

interface ShelfGesture {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastTime: number
  velocityX: number
}

const INITIAL_SHELF_LAYOUT: ShelfLayout = { columns: 6, rows: 2, capacity: 12 }
const LONG_PRESS_MS = 500
const LONG_PRESS_TOLERANCE = 10

function cssPixels(styles: CSSStyleDeclaration, name: string, fallback: number) {
  const value = Number.parseFloat(styles.getPropertyValue(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function makeId(prefix: string) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${id}`
}

function titleFromFile(fileName: string) {
  return fileName.replace(/\.pdf$/i, '').trim() || '無題の本'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '処理を完了できませんでした。'
}

function pdfImportErrorMessage(error: unknown) {
  if (error instanceof Error && (error.name === 'PasswordException' || /password/i.test(error.message))) {
    return 'パスワード付きPDFには対応していません。'
  }
  if (error instanceof Error && (error.name === 'InvalidPDFException' || /invalid pdf|format error/i.test(error.message))) {
    return 'PDFを読み込めませんでした。ファイルが破損している可能性があります。'
  }
  return errorMessage(error)
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

function BookTile({ book, coverUrl, organizing, onOpen, onEdit }: {
  book: BookRecord
  coverUrl?: string
  organizing: boolean
  onOpen: () => void
  onEdit: () => void
}) {
  const longPress = useRef<{ timer: number | null; startX: number; startY: number; triggered: boolean }>({
    timer: null,
    startX: 0,
    startY: 0,
    triggered: false,
  })
  const clearLongPress = () => {
    if (longPress.current.timer !== null) window.clearTimeout(longPress.current.timer)
    longPress.current.timer = null
  }
  const finishLongPress = () => {
    clearLongPress()
    if (longPress.current.triggered) window.setTimeout(() => { longPress.current.triggered = false }, 0)
  }
  const percent = Math.round((book.currentPage / Math.max(1, book.pageCount)) * 100)
  useEffect(() => clearLongPress, [])
  return <article className={`book-card ${organizing ? 'is-organizing' : ''}`}>
    <button
      className="book-cover"
      aria-label={`${book.title}を開く。${book.currentPage}/${book.pageCount}ページ`}
      onClick={(event) => {
        if (longPress.current.triggered) {
          event.preventDefault()
          longPress.current.triggered = false
          return
        }
        organizing ? onEdit() : onOpen()
      }}
      onContextMenu={(event) => { event.preventDefault(); onEdit() }}
      onKeyDown={(event) => {
        if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
          event.preventDefault()
          onEdit()
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse') return
        clearLongPress()
        longPress.current.startX = event.clientX
        longPress.current.startY = event.clientY
        longPress.current.triggered = false
        longPress.current.timer = window.setTimeout(() => {
          longPress.current.triggered = true
          navigator.vibrate?.(12)
          onEdit()
        }, LONG_PRESS_MS)
      }}
      onPointerMove={(event) => {
        if (Math.hypot(event.clientX - longPress.current.startX, event.clientY - longPress.current.startY) > LONG_PRESS_TOLERANCE) clearLongPress()
      }}
      onPointerUp={finishLongPress}
      onPointerCancel={() => { clearLongPress(); longPress.current.triggered = false }}
      onPointerLeave={clearLongPress}
    >
      {coverUrl ? <img src={coverUrl} alt="" /> : <span className="fallback-cover"><small>PDF</small>{book.title}</span>}
      <span className="book-progress" style={{ '--progress': `${percent}%` } as React.CSSProperties} aria-hidden="true" />
    </button>
    <button className="book-edit-action" aria-label={`${book.title}の編集メニュー`} onClick={onEdit}>編集</button>
  </article>
}

export function App() {
  const [books, setBooks] = useState<BookRecord[]>([])
  const [shelves, setShelves] = useState<ShelfRecord[]>([])
  const [filter, setFilter] = useState<ShelfFilter>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [readerSaveError, setReaderSaveError] = useState('')
  const [activeBook, setActiveBook] = useState<ActiveBook | null>(null)
  const [editingBook, setEditingBook] = useState<BookRecord | null>(null)
  const [newShelfName, setNewShelfName] = useState('')
  const [addingShelf, setAddingShelf] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const [shelfLayout, setShelfLayout] = useState<ShelfLayout>(INITIAL_SHELF_LAYOUT)
  const [shelfPage, setShelfPage] = useState(0)
  const [shelfDragX, setShelfDragX] = useState(0)
  const [shelfDragging, setShelfDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const libraryMenu = useRef<HTMLDialogElement>(null)
  const importInFlight = useRef(false)
  const bookshelfRef = useRef<HTMLDivElement>(null)
  const shelfGesture = useRef<ShelfGesture | null>(null)
  const shelfPageRef = useRef(0)
  const shelfLayoutRef = useRef(INITIAL_SHELF_LAYOUT)
  const visibleBookCountRef = useRef(0)
  const suppressBookOpenUntil = useRef(0)

  const refresh = async () => {
    const [nextBooks, nextShelves] = await Promise.all([listBooks(), listShelves()])
    setBooks(nextBooks)
    setShelves(nextShelves)
  }

  useEffect(() => {
    let active = true
    void Promise.all([listBooks(), listShelves()])
      .then(([nextBooks, nextShelves]) => {
        if (!active) return
        setBooks(nextBooks)
        setShelves(nextShelves)
      })
      .catch((reason) => active && setError(errorMessage(reason)))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4200)
    return () => window.clearTimeout(timer)
  }, [notice])

  const coverUrls = useMemo(() => {
    const urls = new Map<string, string>()
    books.forEach((book) => {
      if (book.cover) urls.set(book.id, URL.createObjectURL(book.cover))
    })
    return urls
  }, [books])

  useEffect(() => () => coverUrls.forEach((url) => URL.revokeObjectURL(url)), [coverUrls])

  const visibleBooks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ja')
    return books
      .filter((book) => filter === 'all' || (filter === 'unfiled' ? book.shelfId === null : book.shelfId === filter))
      .filter((book) => !needle || `${book.title} ${book.author}`.toLocaleLowerCase('ja').includes(needle))
      .sort(compareBooksByAddedOrder)
  }, [books, filter, query])

  const shelfPages = useMemo(() => paginate(visibleBooks, shelfLayout.capacity), [visibleBooks, shelfLayout.capacity])
  const currentShelfPage = clampShelfPage(shelfPage, shelfPages.length)

  useEffect(() => { shelfPageRef.current = currentShelfPage }, [currentShelfPage])
  useEffect(() => { shelfLayoutRef.current = shelfLayout }, [shelfLayout])
  useEffect(() => { visibleBookCountRef.current = visibleBooks.length }, [visibleBooks.length])
  useEffect(() => { setShelfPage(0); setShelfDragX(0) }, [filter, query])
  useEffect(() => { setShelfPage((page) => clampShelfPage(page, shelfPages.length)) }, [shelfPages.length])

  useEffect(() => {
    const element = bookshelfRef.current
    if (!element) return
    const updateLayout = () => {
      const styles = getComputedStyle(element)
      const width = element.clientWidth - cssPixels(styles, 'padding-left', 0) - cssPixels(styles, 'padding-right', 0)
      const height = element.clientHeight - cssPixels(styles, 'padding-top', 0) - cssPixels(styles, 'padding-bottom', 0)
      if (width < 100 || height < 100) return
      const next = calculateShelfLayout({
        width,
        height,
        slotWidth: cssPixels(styles, '--book-slot-width', 148),
        rowHeight: cssPixels(styles, '--shelf-row-height', 250),
        columnGap: cssPixels(styles, '--book-column-gap', 18),
      })
      const previous = shelfLayoutRef.current
      if (next.columns === previous.columns && next.rows === previous.rows) return
      const anchorIndex = shelfPageRef.current * previous.capacity
      const nextPageCount = Math.max(1, Math.ceil(visibleBookCountRef.current / next.capacity))
      setShelfLayout(next)
      setShelfPage(pageForAnchor(anchorIndex, next.capacity, nextPageCount))
    }
    updateLayout()
    const ShelfResizeObserver = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
    if (!ShelfResizeObserver) {
      window.addEventListener('resize', updateLayout)
      return () => window.removeEventListener('resize', updateLayout)
    }
    const observer = new ShelfResizeObserver(updateLayout)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const selectedShelfName = filter === 'all'
    ? 'すべての本'
    : filter === 'unfiled'
      ? '未分類'
      : shelves.find((shelf) => shelf.id === filter)?.name ?? '本棚'

  const importFiles = async (files: FileList | null) => {
    if (!files?.length || importInFlight.current) return
    importInFlight.current = true
    setImporting(true)
    setError('')
    let imported = 0
    let skipped = 0
    const failures: string[] = []
    try {
      const { inspectPdf } = await import('./lib/pdf')
      if ('storage' in navigator && 'persist' in navigator.storage) void navigator.storage.persist().catch(() => {})
      const savedBooks = await listBooks()
      const knownFiles = new Set(savedBooks.map((book) => `${book.fileName}\u0000${book.fileSize}`))
      let nextAddedAt = Math.max(Date.now(), ...savedBooks.map((book) => Date.parse(book.addedAt) + 1).filter(Number.isFinite))
      for (const file of Array.from(files)) {
        if (file.type !== 'application/pdf' && !file.name.toLocaleLowerCase().endsWith('.pdf')) {
          skipped += 1
          continue
        }
        const fileKey = `${file.name}\u0000${file.size}`
        if (knownFiles.has(fileKey)) {
          skipped += 1
          continue
        }
        try {
          const result = await inspectPdf(file)
          const now = new Date(nextAddedAt++).toISOString()
          await saveBook({
            id: makeId('book'),
            title: titleFromFile(file.name),
            author: '',
            fileName: file.name,
            fileSize: file.size,
            pageCount: result.pageCount,
            currentPage: 1,
            shelfId: filter !== 'all' && filter !== 'unfiled' ? filter : null,
            addedAt: now,
            updatedAt: now,
            lastOpenedAt: null,
            direction: 'rtl',
            cover: result.cover,
          }, file)
          knownFiles.add(fileKey)
          imported += 1
        } catch (reason) {
          failures.push(`「${file.name}」: ${pdfImportErrorMessage(reason)}`)
        }
      }
      setNotice(`追加 ${imported}冊・除外 ${skipped}件・失敗 ${failures.length}件。除外は重複またはPDF以外です。`)
      if (failures.length) setError(`追加できなかったPDFがあります。${failures.join(' / ')}`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      try { await refresh() } catch (reason) {
        setError((previous) => `${previous ? `${previous} ` : ''}本棚の再読み込みに失敗しました。${errorMessage(reason)}`)
      }
      importInFlight.current = false
      setImporting(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const openBook = async (book: BookRecord) => {
    setError('')
    setReaderSaveError('')
    try {
      const file = await getBookPdf(book.id)
      if (!file) throw new Error('PDF原本が見つかりませんでした。この本を削除して、もう一度追加してください。')
      const now = new Date().toISOString()
      const updated = await updateBook(book.id, { lastOpenedAt: now })
      const record = updated ?? book
      setBooks((current) => current.map((item) => item.id === record.id ? record : item))
      setActiveBook({
        id: record.id,
        title: record.title,
        file,
        pageCount: record.pageCount,
        progress: record.currentPage,
        direction: record.direction,
        record,
      })
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const closeReader = () => {
    void exitAppFullscreen()
    setActiveBook(null)
  }

  const applyUpdate = async (id: string, patch: BookUpdate) => {
    const updated = await updateBook(id, patch)
    if (!updated) return
    setBooks((current) => current.map((book) => book.id === id ? updated : book))
    setActiveBook((current) => current?.id === id ? {
      ...current,
      title: updated.title,
      progress: updated.currentPage,
      direction: updated.direction,
      record: updated,
    } : current)
  }

  const saveReadingState = async (id: string, patch: BookUpdate) => {
    try {
      await applyUpdate(id, patch)
    } catch (reason) {
      setReaderSaveError(`読書位置・開き方を保存できませんでした。読書は続けられますが、次回は以前の状態で開きます。${errorMessage(reason)}`)
    }
  }

  const createShelf = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      const shelf = await saveShelf({ id: makeId('shelf'), name: newShelfName, createdAt: new Date().toISOString() })
      setShelves((current) => [...current, shelf])
      setFilter(shelf.id)
      setNewShelfName('')
      setAddingShelf(false)
      libraryMenu.current?.close()
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const removeShelf = async (shelf: ShelfRecord) => {
    if (!window.confirm(`「${shelf.name}」を削除しますか？\n本は未分類へ移動し、PDFは削除されません。`)) return
    await deleteShelf(shelf.id)
    if (filter === shelf.id) setFilter('all')
    await refresh()
    setNotice('本棚を削除し、中の本を未分類へ移しました。')
  }

  const removeBook = async (book: BookRecord) => {
    if (!window.confirm(`「${book.title}」と端末内のPDFを削除しますか？\nこの操作は取り消せません。`)) return
    try {
      await deleteBook(book.id)
      setBooks((current) => current.filter((item) => item.id !== book.id))
      setEditingBook(null)
      setNotice('本を削除しました。')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  return (
    <main className="app-shell">
      <div inert={activeBook ? true : undefined} aria-hidden={activeBook ? true : undefined}>
      <button className="library-menu-trigger" aria-haspopup="dialog" aria-controls="library-menu" onClick={() => libraryMenu.current?.showModal()}>
        <span>{selectedShelfName}</span><span className="library-menu-hint">{query ? '検索中 · ' : ''}メニュー</span>
      </button>
      <input ref={fileInput} hidden type="file" accept="application/pdf,.pdf" multiple onChange={(event) => void importFiles(event.target.files)} />
      <dialog ref={libraryMenu} id="library-menu" className="library-sidebar" aria-labelledby="library-menu-title" onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect()
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close()
        }
      }}>
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div><p className="brand-kicker">PDF LIBRARY</p><h1 id="library-menu-title">書斎</h1></div>
          <button className="library-menu-close" aria-label="メニューを閉じる" onClick={() => libraryMenu.current?.close()}>×</button>
        </div>
        <div className="header-actions">
          <label className="search-field"><span className="sr-only">本を検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="本を検索" /></label>
          {query && <button className="search-clear" onClick={() => setQuery('')}>検索を解除</button>}
          <button className="import-button" disabled={importing} onClick={() => { libraryMenu.current?.close(); fileInput.current?.click() }}>{importing ? '表紙を準備中…' : 'PDFを追加'}</button>
          <button className="organize-button" onClick={() => { setOrganizing(true); libraryMenu.current?.close() }}>本棚を整理</button>
        </div>
        <nav className="shelf-nav" aria-label="表示する本棚">
          <button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}><span>すべての本</span><strong>{books.length}</strong></button>
          <button className={filter === 'unfiled' ? 'selected' : ''} onClick={() => setFilter('unfiled')}><span>未分類</span><strong>{books.filter((book) => !book.shelfId).length}</strong></button>
          {shelves.map((shelf) => (
            <div className="shelf-nav-row" key={shelf.id}>
              <button className={filter === shelf.id ? 'selected' : ''} onClick={() => setFilter(shelf.id)}><span>{shelf.name}</span><strong>{books.filter((book) => book.shelfId === shelf.id).length}</strong></button>
              <button className="shelf-delete" aria-label={`${shelf.name}を削除`} onClick={() => void removeShelf(shelf).catch((reason) => setError(errorMessage(reason)))}>×</button>
            </div>
          ))}
        </nav>
        {addingShelf ? (
          <form className="new-shelf-form" onSubmit={(event) => void createShelf(event)}>
            <label htmlFor="new-shelf">本棚の名前</label>
            <input id="new-shelf" autoFocus maxLength={80} value={newShelfName} onChange={(event) => setNewShelfName(event.target.value)} />
            <div><button type="button" onClick={() => setAddingShelf(false)}>取消</button><button className="primary" type="submit">追加</button></div>
          </form>
        ) : <button className="add-shelf" onClick={() => setAddingShelf(true)}>＋ 本棚を追加</button>}
        <button className="show-library" onClick={() => libraryMenu.current?.close()}>{query ? `検索結果を見る · ${visibleBooks.length}冊` : `${selectedShelfName}を見る · ${visibleBooks.length}冊`}</button>
        {error && <p className="menu-error" role="alert">{error}</p>}
        <p className="privacy-note">PDFはこの端末だけに保存</p>
      </dialog>

      <section className="library-main">
        <h2 className="sr-only">{selectedShelfName}</h2>
        {importing && <div className="import-status" role="status">表紙を準備中…</div>}

        <div className="library-feedback">
          {error && <div className="message error-message" role="alert"><span>{error}</span><button aria-label="エラーを閉じる" onClick={() => setError('')}>×</button></div>}
          {notice && <div className="message notice-message" role="status">{notice}</div>}
        </div>

        {organizing && <div className="organize-bar" role="status"><span>整理中 — 本を選ぶと編集できます</span><button onClick={() => setOrganizing(false)}>完了</button></div>}
        <div
          ref={bookshelfRef}
          className={`bookshelf ${shelfDragging ? 'is-dragging' : ''}`}
          aria-busy={loading || importing}
          aria-label={`${selectedShelfName}、棚ページ${currentShelfPage + 1}/${shelfPages.length}`}
          style={{ '--shelf-columns': shelfLayout.columns, '--shelf-rows': shelfLayout.rows } as React.CSSProperties}
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return
            shelfGesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastTime: performance.now(), velocityX: 0 }
          }}
          onPointerMove={(event) => {
            const gesture = shelfGesture.current
            if (!gesture || gesture.pointerId !== event.pointerId) return
            const dx = event.clientX - gesture.startX
            const dy = event.clientY - gesture.startY
            const now = performance.now()
            gesture.velocityX = (event.clientX - gesture.lastX) / Math.max(1, now - gesture.lastTime)
            gesture.lastX = event.clientX
            gesture.lastTime = now
            if (Math.abs(dx) > 5 && Math.abs(dx) > Math.abs(dy)) {
              event.preventDefault()
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId)
              const atEdge = (dx > 0 && currentShelfPage === 0) || (dx < 0 && currentShelfPage === shelfPages.length - 1)
              setShelfDragging(true)
              setShelfDragX(atEdge ? dx * .2 : dx)
            }
          }}
          onPointerCancel={() => { shelfGesture.current = null; setShelfDragging(false); setShelfDragX(0) }}
          onPointerUp={(event) => {
            const gesture = shelfGesture.current
            shelfGesture.current = null
            if (!gesture || gesture.pointerId !== event.pointerId) return
            const dx = event.clientX - gesture.startX
            const dy = event.clientY - gesture.startY
            const shouldMove = Math.abs(dx) > Math.max(52, event.currentTarget.clientWidth * .1) || Math.abs(gesture.velocityX) > .5
            if (shouldMove && Math.abs(dx) > Math.abs(dy) * 1.1) {
              const next = clampShelfPage(currentShelfPage + (dx < 0 ? 1 : -1), shelfPages.length)
              if (next !== currentShelfPage) {
                setShelfPage(next)
                suppressBookOpenUntil.current = performance.now() + 350
              }
            }
            setShelfDragging(false)
            setShelfDragX(0)
          }}
        >
          {loading ? (
            <div className="empty-shelf" role="status"><div className="loading-books" aria-hidden="true"><i /><i /><i /></div><h3>本棚を整えています</h3></div>
          ) : visibleBooks.length ? (
            <div className="shelf-viewport">
              <div className="shelf-track" style={{ transform: `translate3d(calc(${-currentShelfPage * 100}% + ${shelfDragX}px), 0, 0)` }}>
                {shelfPages.map((pageBooks, pageIndex) => <section className="shelf-page" key={pageIndex} aria-label={`棚ページ${pageIndex + 1}`} aria-hidden={pageIndex !== currentShelfPage} inert={pageIndex !== currentShelfPage ? true : undefined}>
                  <div className="book-grid">
                    {pageBooks.map((book) => <BookTile key={book.id} book={book} coverUrl={coverUrls.get(book.id)} organizing={organizing} onOpen={() => {
                      if (performance.now() >= suppressBookOpenUntil.current) void openBook(book)
                    }} onEdit={() => setEditingBook(book)} />)}
                  </div>
                </section>)}
              </div>
            </div>
          ) : (
            <div className="empty-shelf">
              <span className="empty-book" aria-hidden="true" />
              <h3>{query ? '該当する本がありません' : 'ここに最初の一冊を'}</h3>
              <p>{query ? '別の言葉で検索してみてください。' : 'PDFを追加すると、表紙を作って本棚に並べます。'}</p>
              {!query && <button className="empty-import" onClick={() => fileInput.current?.click()}>PDFを選ぶ</button>}
            </div>
          )}
          {!loading && shelfPages.length > 1 && <nav className="shelf-page-indicator" aria-label="棚ページ">
            {shelfPages.length <= 7 ? shelfPages.map((_, index) => <button key={index} className={index === currentShelfPage ? 'selected' : ''} aria-label={`棚ページ${index + 1}へ移動`} aria-current={index === currentShelfPage ? 'page' : undefined} onClick={() => setShelfPage(index)}><span /></button>) : <span>{currentShelfPage + 1} / {shelfPages.length}</span>}
          </nav>}
        </div>
      </section>

      {editingBook && <BookEditor book={editingBook} shelves={shelves} onClose={() => setEditingBook(null)} onDelete={() => void removeBook(editingBook)} onSave={async (patch) => {
        try {
          await applyUpdate(editingBook.id, patch)
          if ('shelfId' in patch && patch.shelfId !== editingBook.shelfId) setShelfPage(0)
          setEditingBook(null)
          setNotice('本の情報を更新しました。')
        } catch (reason) { setError(errorMessage(reason)) }
      }} />}

      </div>
      {activeBook && <Suspense fallback={<section className="reader-loading" role="dialog" aria-modal="true" aria-label={`${activeBook.title}を開いています`}>本を開いています…</section>}>
        <Reader key={activeBook.id} book={activeBook} onClose={closeReader} onProgress={(page) => {
          if (page !== activeBook.record.currentPage) void saveReadingState(activeBook.id, { currentPage: page })
        }} onDirectionChange={(direction) => void saveReadingState(activeBook.id, { direction })} />
      </Suspense>}
      {activeBook && readerSaveError && <div className="message error-message" role="alert" style={{ position: 'fixed', top: 'max(72px, env(safe-area-inset-top))', left: '5%', right: '5%', zIndex: 1000 }}><span>{readerSaveError}</span><button aria-label="保存エラーを閉じる" onClick={() => setReaderSaveError('')}>×</button></div>}
    </main>
  )
}

function BookEditor({ book, shelves, onClose, onDelete, onSave }: {
  book: BookRecord
  shelves: ShelfRecord[]
  onClose: () => void
  onDelete: () => void
  onSave: (patch: BookUpdate) => Promise<void>
}) {
  const [title, setTitle] = useState(book.title)
  const [author, setAuthor] = useState(book.author)
  const [shelfId, setShelfId] = useState(book.shelfId ?? '')
  const [direction, setDirection] = useState(book.direction)
  const [replacementCover, setReplacementCover] = useState<Blob | undefined>()
  const coverPreview = useMemo(() => {
    const cover = replacementCover ?? book.cover
    return cover ? URL.createObjectURL(cover) : ''
  }, [book.cover, replacementCover])
  useEffect(() => () => { if (coverPreview) URL.revokeObjectURL(coverPreview) }, [coverPreview])
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="book-dialog" role="dialog" aria-modal="true" aria-labelledby="book-dialog-title">
      <header><div><p>BOOK DETAILS</p><h2 id="book-dialog-title">本の情報</h2></div><button aria-label="閉じる" onClick={onClose}>×</button></header>
      <form onSubmit={(event) => { event.preventDefault(); void onSave({ title, author, shelfId: shelfId || null, direction, ...(replacementCover ? { cover: replacementCover } : {}) }) }}>
        <label>タイトル<input autoFocus required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>著者・発行元<input maxLength={120} value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="任意" /></label>
        <label>表紙画像<span className="cover-picker">{coverPreview ? <img src={coverPreview} alt="現在の表紙プレビュー" /> : <span>表紙なし</span>}<input type="file" accept="image/*" onChange={(event) => setReplacementCover(event.target.files?.[0])} /></span></label>
        <div className="dialog-fields"><label>本棚<select value={shelfId} onChange={(event) => setShelfId(event.target.value)}><option value="">未分類</option>{shelves.map((shelf) => <option value={shelf.id} key={shelf.id}>{shelf.name}</option>)}</select></label>
          <label>開き方<select value={direction} onChange={(event) => setDirection(event.target.value as 'rtl' | 'ltr')}><option value="rtl">右開き</option><option value="ltr">左開き</option></select></label></div>
        <p className="file-detail">{book.fileName} · {formatBytes(book.fileSize)} · {book.pageCount}ページ</p>
        <footer><button type="button" className="danger" onClick={onDelete}>この本を削除</button><div><button type="button" onClick={onClose}>キャンセル</button><button className="primary" type="submit">保存</button></div></footer>
      </form>
    </section>
  </div>
}
