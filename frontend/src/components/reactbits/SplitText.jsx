import React from 'react';

/**
 * The per-character spans exist purely to stagger the reveal animation, but
 * assistive tech reads them as separate items and spells headings out letter
 * by letter. So the real string is carried once in a screen-reader-only span
 * and the animated copy is hidden from the accessibility tree entirely.
 */
export default function SplitText({text, className = '', delay = 30}) {
    const words = text.split(' ');

    return (
        <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
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
                          style={{animationDelay: `${index * delay}ms`}}
                      >
                    {char}
                  </span>
                  );
              })}
            </span>
            </React.Fragment>
        ))}
      </span>
    </span>
    );
}
