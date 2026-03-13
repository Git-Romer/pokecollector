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
        border: {
          DEFAULT: 'rgba(255,255,255,0.07)',
          subtle: 'rgba(255,255,255,0.03)',
        },
        text: {
          primary: '#ffffff',
          secondary: '#a0a0b8',
          muted: '#606078',
        },
        // Pokemon brand — richer, more saturated
        brand: {
          red: 'rgb(var(--color-brand-red-rgb) / <alpha-value>)',
          'red-light': 'var(--color-brand-red-light)',
          'red-dark': 'var(--color-brand-red-dark)',
          'red-glow': 'rgba(227,0,11,0.35)',
        },
        // Status — keeping legacy names for backward compat
        pokemon: {
          red: '#e3000b',
          'red-dark': '#b80009',
          'red-light': '#ff4d4d',
        },
        // Dark theme legacy aliases
        dark: {
          bg: '#08080f',
          surface: '#0f0f1a',
          card: '#141422',
          border: 'rgba(255,255,255,0.07)',
          hover: '#1a1a2e',
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
        // Pokemon gold
        gold: '#f5c842',
        'gold-muted': 'rgba(245,200,66,0.15)',
        'gold-border': 'rgba(245,200,66,0.35)',
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
        glow: '0 0 20px rgba(227,0,11,0.15)',
        'glow-lg': '0 0 30px rgba(227,0,11,0.25)',
        'glow-btn': '0 0 16px rgba(227,0,11,0.3)',
      },
    },
  },
  plugins: [],
}
