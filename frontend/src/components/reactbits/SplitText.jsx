import React from 'react';

export default function SplitText({ text, className = '', delay = 30 }) {
  const words = text.split(' ');

  return (
    <span className={className}>
      {words.map((word, wordIndex) => (
        <React.Fragment key={wordIndex}>
          {wordIndex > 0 && ' '}
          <span className="split-text-word">
            {word.split('').map((char, charIndex) => {
              const index = wordIndex * 5 + charIndex; // rough staggering
              return (
                <span
                  key={charIndex}
                  className="split-text-char"
                  style={{ animationDelay: `${index * delay}ms` }}
                >
                  {char}
                </span>
              );
            })}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
}
