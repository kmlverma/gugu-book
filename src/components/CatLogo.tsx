import React from 'react';

export default function CatLogo({ className = "" }: { className?: string }) {
  return (
    <img 
      src="/cat.png" 
      alt="Gugu Book Logo" 
      className={`object-contain ${className}`}
      onError={(e) => {
        // Fallback if the image isn't uploaded yet
        e.currentTarget.src = "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?q=80&w=500&auto=format&fit=crop";
        e.currentTarget.className = `object-cover rounded-full ${className}`;
      }}
    />
  );
}
