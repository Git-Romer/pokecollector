import React from 'react';
import './OrbitImages.css';

export default function OrbitImages({ images = [], centralText = "ARCHIVE", className = '' }) {
  return (
    <div className={`orbit-container ${className}`}>
      <div className="orbit-center">
        <span>{centralText}</span>
      </div>
      {images.map((img, i) => {
        const angle = (i / images.length) * 360;
        return (
          <div
            key={i}
            className="orbit-item"
            style={{
              '--angle': `${angle}deg`,
              '--delay': `${i * -2}s`
            }}
          >
            <img src={img} alt={`Orbit ${i}`} />
          </div>
        );
      })}
    </div>
  );
}
