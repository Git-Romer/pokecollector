import React from 'react';
import './ColorBends.css';

export default function ColorBends({children, className = '', opacity = 0.4}) {
    return (
        <div className={`color-bends-wrapper ${className}`}>
            <div className="color-bends-bg" style={{opacity}}>
                <div className="bend-1"></div>
                <div className="bend-2"></div>
                <div className="bend-3"></div>
                <div className="bend-4"></div>
            </div>
            <div className="color-bends-content">
                {children}
            </div>
        </div>
    );
}
