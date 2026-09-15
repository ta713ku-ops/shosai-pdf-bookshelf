import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BookRecord } from './domain/books'

const mocks = vi.hoisted(() => ({
  listBooks: vi.fn(),
  listShelves: vi.fn(),
  saveBook: vi.fn(),
  saveShelf: vi.fn(),
  saveShelfAndMoveBooks: vi.fn(),
  moveBooksToShelf: vi.fn(),
  updateBook: vi.fn(),
  inspectPdf: vi.fn(),
  getBookPdf: vi.fn(),
}))
vi.mock('./data/libraryDb', () => ({ ...mocks, deleteBook: vi.fn(), deleteShelf: vi.fn() }))
vi.mock('./lib/pdf', () => ({ inspectPdf: mocks.inspectPdf }))
vi.mock('./lib/fullscreen', () => ({ requestAppFullscreen: vi.fn(), exitAppFullscreen: vi.fn() }))
vi.mock('./components/Reader', () => ({ Reader: ({ onProgress, onDirectionChange, onClose }: { onProgress: (page: number) => void; onDirectionChange: (direction: string) => void; onClose: () => void }) => <section aria-label="テストリーダー"><button onClick={() => onProgress(2)}>次のページ</button><button onClick={() => onDirectionChange('ltr')}>開き方変更</button><button onClick={onClose}>本棚に戻る</button></section> }))
import { App } from './App'

const book: BookRecord = { id: 'one', title: '既存の本', author: '', fileName: 'existing.pdf', fileSize: 1, pageCount: 5, currentPage: 1, shelfId: null, addedAt: '2026-09-09', updatedAt: '2026-09-09', lastOpenedAt: null, direction: 'rtl' }
let saved: BookRecord[]

beforeEach(() => {
  cleanup()
  vi.resetAllMocks()
  saved = []
  mocks.listBooks.mockImplementation(async () => [...saved])
  mocks.listShelves.mockResolvedValue([])
  mocks.getBookPdf.mockResolvedValue(new Blob(['pdf']))
  mocks.inspectPdf.mockResolvedValue({ pageCount: 5 })
  mocks.saveBook.mockImplementation(async (record: BookRecord) => { saved.push(record); return record })
  mocks.saveShelf.mockImplementation(async (shelf) => shelf)
  mocks.moveBooksToShelf.mockImplementation(async (ids: string[], shelfId: string | null) => {
    const selected = new Set(ids)
    saved = saved.map((record) => selected.has(record.id) ? { ...record, shelfId } : record)
    return saved.filter((record) => selected.has(record.id))
  })
  mocks.saveShelfAndMoveBooks.mockImplementation(async (shelf, ids: string[]) => {
    const books = await mocks.moveBooksToShelf(ids, shelf.id)
    return { shelf, books }
  })
})

describe('本棚の一括整理', () => {
  const secondBook: BookRecord = { ...book, id: 'two', title: '二冊目の本', fileName: 'second.pdf', addedAt: '2026-09-10', updatedAt: '2026-09-10' }
  const shelf = { id: 'shelf-1', name: '資料', createdAt: '2026-09-11' }

  it('複数冊を選択して既存の本棚へ一括移動する', async () => {
    saved = [book, secondBook]
    mocks.listShelves.mockResolvedValue([shelf])
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /すべての本.*メニュー/ }))
    fireEvent.click(screen.getByRole('button', { name: '本棚を整理' }))
    const first = screen.getByRole('button', { name: '既存の本を選択' })
    const second = screen.getByRole('button', { name: '二冊目の本を選択' })
    fireEvent.click(first)
    fireEvent.click(second)

    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(second).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('dialog', { name: '本の情報' })).not.toBeInTheDocument()
    expect(screen.getByText('2冊選択')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('移動先の本棚'), { target: { value: shelf.id } })
    fireEvent.click(screen.getByRole('button', { name: /^移動$/ }))

    await waitFor(() => expect(mocks.moveBooksToShelf).toHaveBeenCalledWith(['one', 'two'], shelf.id))
    expect(await screen.findByText('2冊を移動しました。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /資料.*メニュー/ })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '本棚の整理' })).not.toBeInTheDocument()
  })

  it('選択なしで本棚を作成しても現在の本と表紙表示を維持する', async () => {
    saved = [book]
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /すべての本.*メニュー/ }))
    fireEvent.click(screen.getByRole('button', { name: /本棚を追加/ }))
    fireEvent.change(screen.getByLabelText('本棚の名前'), { target: { value: '新しい本棚' } })
    fireEvent.click(screen.getByRole('button', { name: /^追加$/ }))

    expect(await screen.findByText('「新しい本棚」を追加しました。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /すべての本.*メニュー/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /既存の本を開く/ })).toBeInTheDocument()
    expect(mocks.saveShelfAndMoveBooks).not.toHaveBeenCalled()
  })

  it('選択中に新しい本棚を作ると選択した本を同時に移動する', async () => {
    saved = [book, secondBook]
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /すべての本.*メニュー/ }))
    fireEvent.click(screen.getByRole('button', { name: '本棚を整理' }))
    fireEvent.click(screen.getByRole('button', { name: '既存の本を選択' }))
    fireEvent.click(screen.getByRole('button', { name: '二冊目の本を選択' }))
    fireEvent.click(screen.getByRole('button', { name: '新しい本棚' }))
    fireEvent.change(screen.getByLabelText('本棚の名前'), { target: { value: 'まとめた本' } })
    fireEvent.click(screen.getByRole('button', { name: '追加して2冊を移動' }))

    await waitFor(() => expect(mocks.saveShelfAndMoveBooks).toHaveBeenCalledWith(expect.objectContaining({ name: 'まとめた本' }), ['one', 'two']))
    expect(await screen.findByText('「まとめた本」を作成し、2冊を移動しました。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /まとめた本.*メニュー/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /既存の本を開く/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /二冊目の本を開く/ })).toBeInTheDocument()
  })
})

describe('取り込みと読書状態の保存', () => {
  it('部分失敗後も後続ファイルを保存し、再試行で成功済みファイルを重複保存しない', async () => {
    mocks.inspectPdf.mockImplementation(async (file: File) => {
      if (file.name === 'broken.pdf') throw new Error('破損したPDFです')
      return { pageCount: 5 }
    })
    const { container } = render(<App />)
    await waitFor(() => expect(mocks.listBooks).toHaveBeenCalled())
    const files = [new File(['one'], 'first.pdf'), new File(['bad'], 'broken.pdf'), new File(['two'], 'last.pdf'), new File(['text'], 'note.txt')]
    const input = container.querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files } })
    await screen.findByText('追加 2冊・除外 1件・失敗 1件。除外は重複またはPDF以外です。')
    await screen.findByText('last')
    expect(saved).toHaveLength(2)
    fireEvent.change(input, { target: { files } })
    await screen.findByText('追加 0冊・除外 3件・失敗 1件。除外は重複またはPDF以外です。')
    expect(mocks.saveBook).toHaveBeenCalledTimes(2)
  })

  it.each(['次のページ', '開き方変更'])('%sの保存失敗をリーダーを維持して通知する', async (action) => {
    saved = [book]
    mocks.updateBook.mockResolvedValueOnce(book).mockRejectedValue(new Error('端末の保存容量が不足しています。'))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '既存の本を開く。1/5ページ' }))
    fireEvent.click(await screen.findByRole('button', { name: action }))
    expect(await screen.findByRole('alert')).toHaveTextContent('読書位置・開き方を保存できませんでした')
    expect(screen.getByRole('region', { name: 'テストリーダー' })).toBeInTheDocument()
  })

  it('読書位置を保存して本棚へ戻っても表紙URLを維持する', async () => {
    const originalCover = new Blob(['original-cover'], { type: 'image/png' })
    const coveredBook = { ...book, cover: originalCover }
    saved = [coveredBook]
    const createObjectURL = vi.fn(() => 'blob:stable-cover')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    mocks.updateBook.mockImplementation(async (_id: string, patch: Partial<BookRecord>) => ({
      ...coveredBook,
      ...patch,
      cover: new Blob(['indexed-db-clone'], { type: 'image/png' }),
    }))

    render(<App />)
    const open = await screen.findByRole('button', { name: '既存の本を開く。1/5ページ' })
    await waitFor(() => expect(open.querySelector('img')).toHaveAttribute('src', 'blob:stable-cover'))
    fireEvent.click(open)
    fireEvent.click(await screen.findByRole('button', { name: '次のページ' }))
    fireEvent.click(screen.getByRole('button', { name: '本棚に戻る' }))

    await waitFor(() => expect(screen.queryByRole('region', { name: 'テストリーダー' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '既存の本を開く。2/5ページ' }).querySelector('img')).toHaveAttribute('src', 'blob:stable-cover')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })
})
