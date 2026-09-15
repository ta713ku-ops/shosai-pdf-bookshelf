import { describe, expect, it } from 'vitest';
import { applyBookUpdate, normalizeBook, normalizeShelfName, type BookRecord } from '../domain/books';
import { listBooks } from './libraryDb';

const book: BookRecord = {
  id: 'book-1', title: '  読書  ', author: ' 著者 ', fileName: 'sample.pdf', fileSize: 50,
  pageCount: 20, currentPage: 1, shelfId: null, addedAt: '2026-09-08T00:00:00Z',
  updatedAt: '2026-09-08T00:00:00Z', lastOpenedAt: null, direction: 'rtl',
};

describe('book metadata', () => {
  it('normalizes titles and uses filename for a blank title', () => {
    expect(normalizeBook(book)).toMatchObject({ title: '読書', author: '著者' });
    expect(normalizeBook({ ...book, title: ' ' }).title).toBe('sample');
  });
  it('keeps pages within the PDF range', () => {
    expect(normalizeBook({ ...book, currentPage: 100 }).currentPage).toBe(20);
    expect(normalizeBook({ ...book, currentPage: -1 }).currentPage).toBe(1);
    expect(normalizeBook({ ...book, pageCount: NaN, currentPage: Infinity })).toMatchObject({ pageCount: 1, currentPage: 1 });
  });
  it('updates reading position without losing identity or file metadata', () => {
    const cover = new Blob(['cover'], { type: 'image/png' });
    const updated = applyBookUpdate({ ...book, cover }, { currentPage: 8, shelfId: 'shelf-1' }, 'later');
    expect(updated).toMatchObject({ id: book.id, fileName: book.fileName, currentPage: 8, shelfId: 'shelf-1', updatedAt: 'later', addedAt: book.addedAt });
    expect(updated.cover).toBe(cover);
    expect(book.currentPage).toBe(1);
  });
});

describe('shelf names', () => {
  it('trims whitespace and rejects empty or excessively long names', () => {
    expect(normalizeShelfName('  小説  ')).toBe('小説');
    expect(() => normalizeShelfName('  ')).toThrow('本棚の名前を入力');
    expect(() => normalizeShelfName('あ'.repeat(81))).toThrow('80文字');
  });
});

it('explains unavailable device storage in Japanese', async () => {
  if (typeof indexedDB === 'undefined') {
    await expect(listBooks()).rejects.toThrow('端末内保存を利用できません');
  }
});
