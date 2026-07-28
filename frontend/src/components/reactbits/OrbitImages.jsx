import React from 'react';
import './OrbitImages.css';

export default function OrbitImages({images = [], centralText = "ARCHIVE", className = ''}) {
    return (
        <div className={`orbit-container ${className}`}>
            <div className="orbit-center">
                {/* Decorative: the surrounding section already names itself, so this
            glyph would otherwise leak into the page as bare content. */}
                <span aria-hidden="true">{centralText}</span>
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
                        {/* The orbit is ambient dressing for the featured collection. The
                same cards are named in the surrounding content, so these
                repeated images should not become six meaningless landmarks. */}
                        <img src={img} alt="" aria-hidden="true"/>
                    </div>
                );
            })}
        </div>
    );
}
