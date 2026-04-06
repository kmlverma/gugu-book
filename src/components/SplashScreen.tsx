import { motion } from 'motion/react';
import CatLogo from './CatLogo';

export default function SplashScreen() {
  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.8, ease: "easeInOut" }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-warm"
    >
      <div className="flex flex-col items-center gap-6">
        <motion.div
          initial={{ scale: 0.8, opacity: 0, rotateY: -90 }}
          animate={{ scale: 1, opacity: 1, rotateY: 0 }}
          transition={{ 
            duration: 1.2, 
            ease: [0.22, 1, 0.36, 1],
            opacity: { duration: 0.8 }
          }}
          className="relative"
        >
          <div className="bg-white rounded-2xl shadow-2xl shadow-gold/20 overflow-hidden w-32 h-32 flex items-center justify-center">
            <CatLogo className="w-full h-full" />
          </div>
          
          {/* Soft Glow */}
          <motion.div 
            animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.5, 0.3] }}
            transition={{ duration: 3, repeat: Infinity }}
            className="absolute inset-0 bg-gold blur-3xl -z-10 opacity-30"
          />
        </motion.div>
        
        <motion.h1
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.8 }}
          className="text-3xl font-bold tracking-tight text-ink"
        >
          Gugu Book
        </motion.h1>
      </div>
    </motion.div>
  );
}
