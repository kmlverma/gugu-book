import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, MoreVertical, Trash2, Info, Edit3 } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Book } from '../lib/db';
import { cn } from '../lib/utils';
import { extractMetadata } from '../lib/epub-utils';
import CatLogo from './CatLogo';

const IMPORTING_CAT_SRC = '/transparent-cat.png';

interface LibraryProps {
  onOpenBook: (book: Book) => void;
}

export default function Library({ onOpenBook }: LibraryProps) {
  const books = useLiveQuery(() => db.books.orderBy('addedAt').reverse().toArray());
  const currentlyReading = books?.filter(b => b.progress > 0 && b.progress < 1) || [];
  const [isImporting, setIsImporting] = useState(false);
  const [bookToRemove, setBookToRemove] = useState<number | null>(null);
  const [activeBookMenu, setActiveBookMenu] = useState<number | null>(null);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [bookToRename, setBookToRename] = useState<Book | null>(null);
  const [newBookTitle, setNewBookTitle] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const getProgress = (book: Book) => Math.min(100, Math.max(0, Math.round((book.progress ?? 0) * 100)));

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.name.endsWith('.epub')) return;

    setIsImporting(true);
    try {
      const metadata = await extractMetadata(file);
      await db.books.add({
        ...metadata,
        progress: 0,
        lastLocation: null,
        addedAt: Date.now()
      });
    } catch (err) {
      console.error("Import failed", err);
    } finally {
      setIsImporting(false);
    }
  };

  const removeBook = async (id: number) => {
    setBookToRemove(id);
  };

  const openRenameModal = (book: Book) => {
    setBookToRename(book);
    setNewBookTitle(book.title || '');
    setShowRenameModal(true);
    setActiveBookMenu(null);
  };

  const handleRenameConfirm = async () => {
    if (bookToRename && newBookTitle.trim().length > 0) {
      await db.books.update(bookToRename.id!, { title: newBookTitle.trim() });
    }
    setShowRenameModal(false);
    setBookToRename(null);
    setNewBookTitle('');
  };

  const handleRenameCancel = () => {
    setShowRenameModal(false);
    setBookToRename(null);
    setNewBookTitle('');
  };

  const confirmRemoveBook = async () => {
    if (bookToRemove !== null) {
      await db.books.delete(bookToRemove);
      setBookToRemove(null);
    }
  };

  return (
    <div className="min-h-screen pb-32 px-6 pt-12 max-w-5xl mx-auto">
      <header className="mb-12">
        <div className="flex justify-between items-end mb-8">
          <div>
            <h1 className="text-5xl font-black tracking-tighter mb-2">My Library</h1>
            <p className="text-ink/40 font-bold uppercase text-[10px] tracking-[0.2em]">Curated Collection • {books?.length || 0} Books</p>
          </div>
          <div className="hidden md:flex items-center gap-4 bg-zinc-50 p-4 rounded-3xl border border-zinc-100">
            <div className="flex flex-col items-end">
              <span className="text-[10px] font-black uppercase tracking-widest opacity-40">Reading Goal</span>
              <span className="text-sm font-bold">2 / 5 books this month</span>
            </div>
            <div className="w-10 h-10 rounded-full border-4 border-gold border-t-zinc-200 rotate-45" />
          </div>
        </div>
      </header>

      {/* Currently Reading */}
      {currentlyReading.length > 0 && (
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
            Currently Reading
          </h2>
          <div className="flex gap-6 overflow-x-auto pb-8 -mx-6 px-6 no-scrollbar">
            {currentlyReading.map((book) => (
              <motion.div
                key={book.id}
                whileHover={{ y: -8 }}
                onClick={() => onOpenBook(book)}
                className="flex-shrink-0 w-64 cursor-pointer group"
              >
                <div className="relative aspect-[3/4] rounded-2xl overflow-hidden shadow-xl mb-4 bg-white/50">
                  {book.cover ? (
                    <img 
                      src={book.cover} 
                      alt={book.title} 
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-white">
                      <CatLogo className="w-24 h-24 opacity-50" />
                    </div>
                  )}
                  
                  {/* Progress Bar */}
                  <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/10">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${book.progress * 100}%` }}
                      transition={{ duration: 1, ease: "easeOut" }}
                      className="h-full bg-gold"
                    />
                  </div>

                </div>
                <h3 className="font-bold text-lg leading-tight line-clamp-1">{book.title}</h3>
                <p className="text-ink/60 text-sm font-medium">{book.author}</p>
              </motion.div>
            ))}
          </div>
        </section>
      )}

      {/* Grid */}
      <section>
        <h2 className="text-xl font-semibold mb-6">All Books</h2>
        {books && books.length > 0 ? (
          <>
            {activeBookMenu !== null && (
              <div
                className="fixed inset-0 z-30 bg-black/10"
                onClick={() => setActiveBookMenu(null)}
              />
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-8">
              <AnimatePresence mode="popLayout">
                {books.map((book, index) => (
                  <motion.div
                  key={book.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  layout
                  className="group relative"
                >
                  <div 
                    onClick={(e) => {
                      e.stopPropagation();
                      if (activeBookMenu !== null) {
                        setActiveBookMenu(null);
                        return;
                      }
                      onOpenBook(book);
                    }}
                    className="cursor-pointer"
                  >
                    <div className="relative aspect-[3/4] rounded-xl overflow-hidden shadow-md group-hover:shadow-2xl transition-all duration-500 mb-1 bg-white/50">
                      {book.cover ? (
                        <img 
                          src={book.cover} 
                          alt={book.title} 
                          className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-zinc-100 text-center px-4">
                          <h3 className="font-bold text-sm leading-tight">{book.title}</h3>
                          <p className="text-zinc-600 text-xs">{book.author}</p>
                        </div>
                      )}

                        <div className="absolute inset-x-0 bottom-0 p-2 bg-black/60 backdrop-blur-sm text-white">
                        <h3 className="text-[11px] font-bold leading-tight line-clamp-1">{book.title}</h3>
                        <p className="text-[10px] text-white/80 line-clamp-1">{book.author}</p>
                      </div>

                    </div>

                    {/* Footer: progress + actions */}
                    <div className="flex items-center gap-2 mt-2">
                      <div className="flex-1">
                        <div className="h-2 rounded-full overflow-hidden bg-zinc-200">
                          <div
                            className="h-full bg-gold transition-all duration-300"
                            style={{ width: `${getProgress(book)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-[11px] text-zinc-500 font-semibold">{getProgress(book)}%</p>
                      </div>

                      <div className="relative">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!book.id) return;
                            setActiveBookMenu(activeBookMenu === book.id ? null : book.id);
                          }}
                          className="p-2 bg-white/95 backdrop-blur rounded-full shadow-lg text-zinc-700 hover:bg-zinc-100"
                        >
                          <MoreVertical size={16} />
                        </button>

                        <AnimatePresence>
                          {activeBookMenu === book.id && (
                            <motion.div
                              initial={{ opacity: 0, y: -8, scale: 0.95 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -8, scale: 0.95 }}
                              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                              className="absolute right-0 bottom-full mb-3 w-44 bg-white border border-zinc-200 rounded-3xl shadow-xl p-2 z-50"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openRenameModal(book);
                                }}
                                className="flex items-center gap-2 w-full px-3 py-2 rounded-xl hover:bg-zinc-100"
                              >
                                <Edit3 size={16} />
                                Rename
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveBookMenu(null);
                                  removeBook(book.id!);
                                }}
                                className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-red-600 hover:bg-red-50"
                              >
                                <Trash2 size={16} />
                                Remove
                              </button>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-32 text-center" onClick={() => setActiveBookMenu(null)}>
            <div className="w-24 h-24 bg-white rounded-full flex items-center justify-center mb-6 shadow-sm">
              <CatLogo className="w-16 h-16 opacity-50" />
            </div>
            <h3 className="text-xl font-bold mb-2">Your library is empty</h3>
            <p className="text-ink/50 max-w-xs">Tap the + button to import your first ePub book and start reading.</p>
          </div>
        )}
      </section>

      {/* FAB */}
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.9, rotate: 90 }}
        onClick={() => fileInputRef.current?.click()}
        className="fixed bottom-10 right-10 w-16 h-16 bg-gold text-white rounded-full shadow-2xl shadow-gold/40 flex items-center justify-center z-40"
      >
        <Plus size={32} />
      </motion.button>

      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept=".epub" 
        className="hidden" 
      />

      <AnimatePresence>
        {bookToRemove !== null && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-white dark:bg-zinc-900 rounded-3xl p-6 max-w-sm w-full shadow-2xl"
            >
              <h3 className="text-xl font-bold mb-2">Remove Book</h3>
              <p className="text-zinc-500 dark:text-zinc-400 mb-6">Are you sure you want to remove this book from your library? This action cannot be undone.</p>
              <div className="flex gap-3">
                <button 
                  onClick={() => setBookToRemove(null)}
                  className="flex-1 py-3 px-4 rounded-xl font-bold bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={confirmRemoveBook}
                  className="flex-1 py-3 px-4 rounded-xl font-bold bg-red-500 text-white hover:bg-red-600 transition-colors shadow-lg shadow-red-500/30"
                >
                  Remove
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showRenameModal && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-white dark:bg-zinc-900 rounded-3xl p-6 max-w-sm w-full shadow-2xl"
            >
              <h3 className="text-xl font-bold mb-4">Rename Book</h3>
              <input
                ref={renameInputRef}
                type="text"
                value={newBookTitle}
                onChange={(e) => setNewBookTitle(e.target.value)}
                placeholder="Enter book name"
                autoFocus
                className="w-full px-4 py-3 border border-zinc-300 dark:border-zinc-700 rounded-xl bg-white dark:bg-zinc-800 text-black dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-gold"
              />
              <div className="flex gap-3 mt-6">
                <button 
                  onClick={handleRenameCancel}
                  className="flex-1 py-3 px-4 rounded-xl font-bold bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleRenameConfirm}
                  className="flex-1 py-3 px-4 rounded-xl font-bold bg-gold text-white hover:bg-gold/90 transition-colors shadow-lg shadow-gold/30 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={newBookTitle.trim().length === 0}
                >
                  OK
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {isImporting && (
        <div className="fixed inset-0 bg-white/80 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <motion.div 
              animate={{ scale: [1, 1.1, 1], rotate: [0, 5, -5, 0] }}
              transition={{ duration: 1.5, repeat: Infinity }}
              className="w-28 h-28 flex items-center justify-center"
            >
              <img src={IMPORTING_CAT_SRC} alt="Importing book" className="w-full h-full object-contain" />
            </motion.div>
            <p className="font-bold text-gold">Importing Book...</p>
          </div>
        </div>
      )}
    </div>
  );
}
