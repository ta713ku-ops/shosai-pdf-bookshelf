import type { BookRecord } from '../domain/books'

export interface ShelfLayoutInput {
  width: number
  height: number
  slotWidth: number
  rowHeight: number
  columnGap: number
}

export interface ShelfLayout {
  columns: number
  rows: number
  capacity: number
}

function positive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function compareBooksByAddedOrder(
  a: Pick<BookRecord, 'addedAt' | 'id'>,
  b: Pick<BookRecord, 'addedAt' | 'id'>,
) {
  return a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id)
}

export function calculateShelfLayout(input: ShelfLayoutInput): ShelfLayout {
  const width = positive(input.width, 1)
  const height = positive(input.height, 1)
  const slotWidth = positive(input.slotWidth, width)
  const rowHeight = positive(input.rowHeight, height)
  const columnGap = Math.max(0, Number.isFinite(input.columnGap) ? input.columnGap : 0)
  const columns = Math.max(1, Math.floor((width + columnGap) / (slotWidth + columnGap)))
  const rows = Math.max(1, Math.floor(height / rowHeight))
  return { columns, rows, capacity: columns * rows }
}

export function paginate<T>(items: readonly T[], capacity: number): T[][] {
  const size = Math.max(1, Math.floor(positive(capacity, 1)))
  if (!items.length) return [[]]
  const pages: T[][] = []
  for (let index = 0; index < items.length; index += size) pages.push(items.slice(index, index + size))
  return pages
}

export function clampShelfPage(page: number, pageCount: number) {
  const last = Math.max(0, Math.floor(positive(pageCount, 1)) - 1)
  return Math.min(last, Math.max(0, Math.floor(Number.isFinite(page) ? page : 0)))
}

export function pageForAnchor(anchorIndex: number, capacity: number, pageCount: number) {
  const size = Math.max(1, Math.floor(positive(capacity, 1)))
  return clampShelfPage(Math.floor(Math.max(0, anchorIndex) / size), pageCount)
}
