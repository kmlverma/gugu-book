import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { App as CapacitorApp } from '@capacitor/app';
import SplashScreen from './components/SplashScreen';
import Library from './components/Library';
import Reader from './components/Reader';
import { type Book } from './lib/db';

export default function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [activeBook, setActiveBook] = useState<Book | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const handlerPromise = CapacitorApp.addListener('backButton', () => {
      if (activeBook) {
        setActiveBook(null);
      } else {
        // Close the app when on main library page
        CapacitorApp.exitApp();
      }
    });

    return () => {
      handlerPromise.then((handler) => handler.remove()).catch(() => {
        // ignore cleanup failure if listener was not registered
      });
    };
  }, [activeBook]);

  return (
    <div className="relative min-h-screen">
      <AnimatePresence mode="wait">
        {showSplash ? (
          <SplashScreen key="splash" />
        ) : (
          <motion.main
            key="library"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8 }}
          >
            <Library onOpenBook={(book) => setActiveBook(book)} />
          </motion.main>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {activeBook && (
          <motion.div
            key="reader"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed inset-0 z-50"
          >
            <Reader
              book={activeBook}
              onClose={() => setActiveBook(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
