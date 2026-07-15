import React from 'react';

export default function AnimatedCard({ children, className = '', isFeatured = false }) {
  return (
    <div className={`mag-card ${isFeatured ? 'mag-card-featured' : ''} ${className}`}>
      {children}
    </div>
  );
}
