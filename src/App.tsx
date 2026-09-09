import { useEffect, useMemo, useRef, useState } from 'react'
import { Reader, type ReaderBook } from './components/Reader'
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
import { inspectPdf } from './lib/pdf'
import { exitAppFullscreen, requestAppFullscreen } from './lib/fullscreen'

type ShelfFilter = 'all' | 'unfiled' | string

interface ActiveBook extends ReaderBook {
  record: BookRecord
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
  const fileInput = useRef<HTMLInputElement>(null)
  const importInFlight = useRef(false)

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
      .sort((a, b) => (b.lastOpenedAt || b.addedAt).localeCompare(a.lastOpenedAt || a.addedAt))
  }, [books, filter, query])

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
      if ('storage' in navigator && 'persist' in navigator.storage) void navigator.storage.persist().catch(() => {})
      const savedBooks = await listBooks()
      const knownFiles = new Set(savedBooks.map((book) => `${book.fileName}\u0000${book.fileSize}`))
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
          const now = new Date().toISOString()
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

  const openBookFromGesture = (book: BookRecord) => {
    void requestAppFullscreen()
    void openBook(book)
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
      <aside className="library-sidebar" aria-label="本棚一覧">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div><p className="brand-kicker">PDF LIBRARY</p><h1>書斎</h1></div>
        </div>
        <nav className="shelf-nav" aria-label="表示する本棚">
          <button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}><span>すべての本</span><strong>{books.length}</strong></button>
          <button className={filter === 'unfiled' ? 'selected' : ''} onClick={() => setFilter('unfiled')}><span>未分類</span><strong>{books.filter((book) => !book.shelfId).length}</strong></button>
          {shelves.map((shelf) => (
            <div className="shelf-nav-row" key={shelf.id}>
              <button className={filter === shelf.id ? 'selected' : ''} onClick={() => setFilter(shelf.id)}><span>{shelf.name}</span><strong>{books.filter((book) => book.shelfId === shelf.id).length}</strong></button>
              <button className="shelf-delete" aria-label={`${shelf.name}を削除`} onClick={() => void removeShelf(shelf)}>×</button>
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
        <p className="privacy-note"><span aria-hidden="true">●</span> PDFはこの端末だけに保存</p>
      </aside>

      <section className="library-main">
        <header className="library-header">
          <div><p className="section-kicker">MY COLLECTION</p><h2>{selectedShelfName}</h2></div>
          <div className="header-actions">
            <label className="search-field"><span className="sr-only">本を検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="本を検索" /></label>
            <input ref={fileInput} hidden type="file" accept="application/pdf,.pdf" multiple onChange={(event) => void importFiles(event.target.files)} />
            <button className="import-button" disabled={importing} onClick={() => fileInput.current?.click()}>{importing ? '表紙を準備中…' : 'PDFを追加'}</button>
          </div>
        </header>

        {error && <div className="message error-message" role="alert"><span>{error}</span><button aria-label="エラーを閉じる" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="message notice-message" role="status">{notice}</div>}

        <div className="bookshelf" aria-busy={loading || importing}>
          {loading ? (
            <div className="empty-shelf" role="status"><div className="loading-books" aria-hidden="true"><i /><i /><i /></div><h3>本棚を整えています</h3></div>
          ) : visibleBooks.length ? (
            <div className="book-grid">
              {visibleBooks.map((book) => {
                const percent = Math.round((book.currentPage / Math.max(1, book.pageCount)) * 100)
                return <article className="book-card" key={book.id}>
                  <button className="book-cover" onClick={() => openBookFromGesture(book)} aria-label={`${book.title}を開く。${book.currentPage}/${book.pageCount}ページ`}>
                    {coverUrls.get(book.id) ? <img src={coverUrls.get(book.id)} alt="" /> : <span className="fallback-cover"><small>PDF</small>{book.title}</span>}
                    <span className="book-progress" style={{ '--progress': `${percent}%` } as React.CSSProperties} aria-hidden="true" />
                  </button>
                  <button className="book-menu" aria-label={`${book.title}の情報を編集`} onClick={() => setEditingBook(book)}>•••</button>
                </article>
              })}
            </div>
          ) : (
            <div className="empty-shelf">
              <span className="empty-book" aria-hidden="true" />
              <h3>{query ? '該当する本がありません' : 'ここに最初の一冊を'}</h3>
              <p>{query ? '別の言葉で検索してみてください。' : 'PDFを追加すると、表紙を作って本棚に並べます。'}</p>
              {!query && <button className="empty-import" onClick={() => fileInput.current?.click()}>PDFを選ぶ</button>}
            </div>
          )}
        </div>
      </section>

      {editingBook && <BookEditor book={editingBook} shelves={shelves} onClose={() => setEditingBook(null)} onDelete={() => void removeBook(editingBook)} onSave={async (patch) => {
        try {
          await applyUpdate(editingBook.id, patch)
          setEditingBook(null)
          setNotice('本の情報を更新しました。')
        } catch (reason) { setError(errorMessage(reason)) }
      }} />}

      {activeBook && <Reader key={activeBook.id} book={activeBook} onClose={closeReader} onProgress={(page) => {
        if (page !== activeBook.record.currentPage) void saveReadingState(activeBook.id, { currentPage: page })
      }} onDirectionChange={(direction) => void saveReadingState(activeBook.id, { direction })} />}
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
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="book-dialog" role="dialog" aria-modal="true" aria-labelledby="book-dialog-title">
      <header><div><p>BOOK DETAILS</p><h2 id="book-dialog-title">本の情報</h2></div><button aria-label="閉じる" onClick={onClose}>×</button></header>
      <form onSubmit={(event) => { event.preventDefault(); void onSave({ title, author, shelfId: shelfId || null, direction }) }}>
        <label>タイトル<input autoFocus required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>著者・発行元<input maxLength={120} value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="任意" /></label>
        <div className="dialog-fields"><label>本棚<select value={shelfId} onChange={(event) => setShelfId(event.target.value)}><option value="">未分類</option>{shelves.map((shelf) => <option value={shelf.id} key={shelf.id}>{shelf.name}</option>)}</select></label>
          <label>開き方<select value={direction} onChange={(event) => setDirection(event.target.value as 'rtl' | 'ltr')}><option value="rtl">右開き</option><option value="ltr">左開き</option></select></label></div>
        <p className="file-detail">{book.fileName} · {formatBytes(book.fileSize)} · {book.pageCount}ページ</p>
        <footer><button type="button" className="danger" onClick={onDelete}>この本を削除</button><div><button type="button" onClick={onClose}>キャンセル</button><button className="primary" type="submit">保存</button></div></footer>
      </form>
    </section>
  </div>
}
