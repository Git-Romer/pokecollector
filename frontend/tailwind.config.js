/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Dark theme backgrounds — deep blue-black
        bg: {
          DEFAULT: 'var(--color-bg)',
          surface: 'var(--color-surface)',
          card: 'var(--color-card)',
          elevated: 'var(--color-elevated)',
        },
        // `subtle` was a second white wash with no usages.
        border: {
          DEFAULT: 'var(--color-border-hairline)',
        },
        text: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted)',
        },
        // Archive semantic aliases retained while existing spaces are refit.
        brand: {
          red: 'rgb(var(--color-brand-red-rgb) / <alpha-value>)',
          'red-light': 'var(--color-brand-red-light)',
          'red-dark': 'var(--color-brand-red-dark)',
        },
        // Semantic status colors
        green: {
          DEFAULT: '#22c55e',
          subtle: '#052e16',
        },
        yellow: {
          DEFAULT: '#eab308',
          subtle: '#1c1807',
        },
        blue: {
          DEFAULT: '#3b82f6',
          subtle: '#0c1a2e',
        },
        // Emphasis colour for names, prices and stat values. Was called
        // `gold` while holding a blue; renamed to its role rather than
        // recoloured, since moving it onto the orange signal is a visual
        // decision. The -muted and -border variants had no usages.
        highlight: '#8fc0ff',
        // Pokemon energy type colors
        'type-fire': '#ff6b35',
        'type-water': '#4fc3f7',
        'type-grass': '#66bb6a',
        'type-lightning': '#fdd835',
        'type-psychic': '#ce93d8',
        'type-fighting': '#ff7043',
        'type-darkness': '#78909c',
        'type-metal': '#b0bec5',
        'type-dragon': '#9575cd',
        'type-fairy': '#f48fb1',
        'type-colorless': '#9e9e9e',
      },

      fontFamily: {
        // Was a Segoe stack, which never applied: both stylesheets set Inter
        // on body, and that cascades over the html rule preflight builds from
        // this token. The spec asks for Inter, so the token now says so.
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },

      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.75rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
        '4xl': ['2.25rem', { lineHeight: '2.5rem' }],
      },

      borderRadius: {
        sm: '0.375rem',
        DEFAULT: '0.5rem',
        md: '0.5rem',
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.25rem',
        '3xl': '1.5rem',
        full: '9999px',
      },

      spacing: {
        'safe-b': 'env(safe-area-inset-bottom)',
        'safe-t': 'env(safe-area-inset-top)',
      },

      height: {
        dvh: '100dvh',
      },

      maxHeight: {
        dvh: '100dvh',
        '85dvh': '85dvh',
      },

      animation: {
        'fade-in': 'fadeIn 0.2s ease-in-out',
        'slide-up': 'slideUp 0.25s ease-out',
        'slide-down': 'slideDown 0.25s ease-out',
        'pulse-slow': 'pulse 3s infinite',
        'spin-slow': 'spin 8s linear infinite',
      },

      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },

      boxShadow: {
        card: '0 2px 8px rgba(0,0,0,0.4)',
        elevated: '0 4px 16px rgba(0,0,0,0.5)',
        // Follows the signal orange. The -lg and -btn variants carried the
        // retired red and had no usages.
        glow: '0 0 20px rgba(245,130,32,0.15)',
      },
    },
  },
  plugins: [],
}
