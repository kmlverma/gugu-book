import Dexie, { type Table } from 'dexie';

export interface Highlight {
  cfiRange: string;
  text: string;
  color: string;
  addedAt: number;
}

export interface Bookmark {
  cfi: string;
  addedAt: number;
  sectionIndex?: number;
  pageInSection?: number;
}

export interface Book {
  id?: number;
  title: string;
  author: string;
  cover: string | null; // Base64 or Blob URL
  data: ArrayBuffer; // The actual ePub file
  progress: number; // 0 to 1
  lastLocation: string | null;
  highlights?: Highlight[];
  bookmark?: any; // legacy single bookmark — kept for backward compat
  bookmarks?: Bookmark[];
  cachedLocations?: string; // JSON from epubjs locations.save() — pre-computed CFI array
  addedAt: number;
}

export class GuguDatabase extends Dexie {
  books!: Table<Book>;

  constructor() {
    super('GuguBookDB');
    this.version(1).stores({
      books: '++id, title, author, addedAt'
    });
  }
}

export const db = new GuguDatabase();
