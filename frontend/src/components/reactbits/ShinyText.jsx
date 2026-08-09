import React from 'react';
import './ShinyText.css';

export default function ShinyText({text, disabled = false, continuous = false, speed = 3, className = ''}) {
    const animationDuration = `${speed}s`;

    return (
        <div
            className={`shiny-text ${disabled ? 'disabled' : ''} ${continuous ? 'continuous' : ''} ${className}`}
            style={{animationDuration}}
        >
            {text}
        </div>
    );
}
