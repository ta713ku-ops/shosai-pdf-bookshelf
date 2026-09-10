import { describe, expect, it } from 'vitest'
import { calculateShelfLayout, clampShelfPage, compareBooksByAddedOrder, pageForAnchor, paginate } from './bookshelf'

describe('bookshelf pages', () => {
  it('calculates rows, columns, and capacity from the usable area', () => {
    expect(calculateShelfLayout({ width: 1000, height: 620, slotWidth: 140, rowHeight: 250, columnGap: 20 }))
      .toEqual({ columns: 6, rows: 2, capacity: 12 })
    expect(calculateShelfLayout({ width: 0, height: 0, slotWidth: 0, rowHeight: 0, columnGap: 0 }))
      .toEqual({ columns: 1, rows: 1, capacity: 1 })
  })

  it('creates display-only pages without dropping items', () => {
    expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(paginate([], 8)).toEqual([[]])
  })

  it('keeps an anchor item visible after the capacity changes', () => {
    expect(pageForAnchor(14, 6, 4)).toBe(2)
    expect(pageForAnchor(14, 20, 1)).toBe(0)
    expect(clampShelfPage(9, 3)).toBe(2)
  })

  it('sorts by added time and uses id as a stable tie breaker', () => {
    const books = [
      { id: 'b', addedAt: '2026-01-02' },
      { id: 'c', addedAt: '2026-01-01' },
      { id: 'a', addedAt: '2026-01-02' },
    ]
    expect([...books].sort(compareBooksByAddedOrder).map((book) => book.id)).toEqual(['c', 'a', 'b'])
  })
})
