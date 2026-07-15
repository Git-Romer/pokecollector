import React from 'react';

export default function Grainient({ children, className = '' }) {
  return (
    <div className={`relative min-h-screen ${className}`}>
      <div className="grain-bg"></div>
      <div className="grain-overlay"></div>
      
      <div className="relative z-10">{children}</div>
    </div>
  );
}
