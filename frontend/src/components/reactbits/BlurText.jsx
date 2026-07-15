import React from 'react';
import './BlurText.css';

export default function BlurText({ text, className = '', delay = 50 }) {
  const words = text.split(' ');

  return (
    <span className={`inline-block ${className}`}>
      {words.map((word, i) => (
        <span
          key={i}
          className="blur-word inline-block mr-[0.25em]"
          style={{ animationDelay: `${i * delay}ms` }}
        >
          {word}
        </span>
      ))}
    </span>
  );
}
