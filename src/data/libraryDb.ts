import { applyBookUpdate, normalizeBook, normalizeShelfName, type BookRecord, type BookUpdate, type ShelfRecord } from '../domain/books';

const DB_NAME = 'shosai-library';
const DB_VERSION = 1;
let connection: Promise<IDBDatabase> | undefined;

function storageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new Error('端末の保存容量が不足しています。不要な本を削除してから、もう一度お試しください。');
  }
  return new Error('本棚を端末に保存・読み込みできませんでした。ブラウザの保存設定と空き容量を確認してください。');
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('このブラウザでは端末内保存を利用できません。Safariなどの対応ブラウザで開いてください。'));
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('books', { keyPath: 'id' });
        db.createObjectStore('pdfs', { keyPath: 'id' });
        db.createObjectStore('shelves', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = undefined; };
        resolve(db);
      };
      request.onerror = () => reject(storageError(request.error));
      request.onblocked = () => reject(new Error('ほかのタブの本棚を閉じてから、もう一度お試しください。'));
    }).catch(error => { connection = undefined; throw error; });
  }
  return connection;
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(storageError(tx.error));
    tx.onerror = () => reject(storageError(tx.error));
    try { run(tx, result => { value = result; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}

export function listBooks(): Promise<BookRecord[]> {
  return transaction(['books'], 'readonly', (tx, result) => {
    const request = tx.objectStore('books').getAll();
    request.onsuccess = () => result(request.result as BookRecord[]);
  });
}

export function getBookPdf(id: string): Promise<Blob | null> {
  return transaction(['pdfs'], 'readonly', (tx, result) => {
    const request = tx.objectStore('pdfs').get(id);
    request.onsuccess = () => result(request.result?.blob ?? null);
  });
}

/** Metadata and PDF are committed together; a failed write leaves neither behind. */
export function saveBook(book: BookRecord, pdf: Blob): Promise<BookRecord> {
  const normalized = normalizeBook(book);
  return transaction(['books', 'pdfs'], 'readwrite', (tx, result) => {
    tx.objectStore('books').put(normalized);
    tx.objectStore('pdfs').put({ id: book.id, blob: pdf });
    result(normalized);
  });
}

export function updateBook(id: string, patch: BookUpdate): Promise<BookRecord | null> {
  return transaction(['books'], 'readwrite', (tx, result) => {
    const store = tx.objectStore('books');
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) { result(null); return; }
      const updated = applyBookUpdate(request.result as BookRecord, patch);
      store.put(updated);
      result(updated);
    };
  });
}

function moveBookRecords(
  tx: IDBTransaction,
  ids: Iterable<string>,
  shelfId: string | null,
  done: (books: BookRecord[]) => void,
) {
  const pending = new Set(ids);
  const updated: BookRecord[] = [];
  const store = tx.objectStore('books');
  const now = new Date().toISOString();
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      done(updated);
      return;
    }
    const book = cursor.value as BookRecord;
    if (pending.has(book.id)) {
      const next = applyBookUpdate(book, { shelfId }, now);
      cursor.update(next);
      updated.push(next);
    }
    cursor.continue();
  };
}

/** Move every selected book atomically so a partial shelf move cannot be saved. */
export function moveBooksToShelf(ids: string[], shelfId: string | null): Promise<BookRecord[]> {
  if (!ids.length) return Promise.resolve([]);
  return transaction(['books'], 'readwrite', (tx, result) => {
    moveBookRecords(tx, ids, shelfId, result);
  });
}

export function deleteBook(id: string): Promise<void> {
  return transaction(['books', 'pdfs'], 'readwrite', tx => {
    tx.objectStore('books').delete(id);
    tx.objectStore('pdfs').delete(id);
  });
}

export function listShelves(): Promise<ShelfRecord[]> {
  return transaction(['shelves'], 'readonly', (tx, result) => {
    const request = tx.objectStore('shelves').getAll();
    request.onsuccess = () => result((request.result as ShelfRecord[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  });
}

export async function saveShelf(shelf: ShelfRecord): Promise<ShelfRecord> {
  const normalized = { ...shelf, name: normalizeShelfName(shelf.name) };
  return transaction(['shelves'], 'readwrite', (tx, result) => {
    tx.objectStore('shelves').put(normalized);
    result(normalized);
  });
}

/** Create a shelf and move the selected books in the same transaction. */
export async function saveShelfAndMoveBooks(
  shelf: ShelfRecord,
  bookIds: string[],
): Promise<{ shelf: ShelfRecord; books: BookRecord[] }> {
  const normalized = { ...shelf, name: normalizeShelfName(shelf.name) };
  return transaction(['books', 'shelves'], 'readwrite', (tx, result) => {
    tx.objectStore('shelves').put(normalized);
    moveBookRecords(tx, bookIds, normalized.id, books => result({ shelf: normalized, books }));
  });
}

/** Removing a shelf preserves its books and their PDFs. */
export function deleteShelf(id: string): Promise<void> {
  return transaction(['books', 'shelves'], 'readwrite', tx => {
    tx.objectStore('shelves').delete(id);
    const request = tx.objectStore('books').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const book = cursor.value as BookRecord;
      if (book.shelfId === id) cursor.update(applyBookUpdate(book, { shelfId: null }));
      cursor.continue();
    };
  });
}
