export interface BookRecord {
  id: string;
  title: string;
  author: string;
  fileName: string;
  fileSize: number;
  pageCount: number;
  currentPage: number;
  shelfId: string | null;
  addedAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  direction: 'rtl' | 'ltr';
  cover?: Blob;
}

export interface ShelfRecord {
  id: string;
  name: string;
  createdAt: string;
}

export type BookUpdate = Partial<Pick<BookRecord, 'title' | 'author' | 'currentPage' | 'shelfId' | 'lastOpenedAt' | 'cover' | 'direction'>>;

export function normalizeBook(book: BookRecord): BookRecord {
  const pageCount = Math.max(1, Math.floor(Number.isFinite(book.pageCount) ? book.pageCount : 1));
  return {
    ...book,
    title: book.title.trim() || book.fileName.replace(/\.pdf$/i, '') || '無題の本',
    author: book.author.trim(),
    pageCount,
    currentPage: Math.min(pageCount, Math.max(1, Math.floor(Number.isFinite(book.currentPage) ? book.currentPage : 1))),
  };
}

export function applyBookUpdate(book: BookRecord, patch: BookUpdate, now = new Date().toISOString()): BookRecord {
  return normalizeBook({ ...book, ...patch, updatedAt: now });
}

export function normalizeShelfName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('本棚の名前を入力してください。');
  if (trimmed.length > 80) throw new Error('本棚の名前は80文字以内で入力してください。');
  return trimmed;
}
