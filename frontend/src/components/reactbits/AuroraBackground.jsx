import React from 'react';
import './AuroraBackground.css';

export default function AuroraBackground({ children, className = '' }) {
  return (
    <div className={`aurora-wrapper ${className}`}>
      <div className="aurora-content">
        {children}
      </div>
      <div className="aurora-bg">
        <div className="aurora-blob blob-1"></div>
        <div className="aurora-blob blob-2"></div>
        <div className="aurora-blob blob-3"></div>
      </div>
    </div>
  );
}
