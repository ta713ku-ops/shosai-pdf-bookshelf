import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BookRecord } from './domain/books'

const mocks = vi.hoisted(() => ({ listBooks: vi.fn(), listShelves: vi.fn(), saveBook: vi.fn(), updateBook: vi.fn(), inspectPdf: vi.fn(), getBookPdf: vi.fn() }))
vi.mock('./data/libraryDb', () => ({ ...mocks, deleteBook: vi.fn(), deleteShelf: vi.fn(), saveShelf: vi.fn() }))
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
