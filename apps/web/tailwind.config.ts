import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#070a0f',
          900: '#0b1017',
          850: '#101722',
          800: '#151d2b',
          700: '#1e2838',
          600: '#2a3648',
          500: '#3d4b60',
          400: '#5b6b83',
          300: '#8a99ae',
          200: '#bcc7d6',
          100: '#e4eaf2',
        },
        accent: {
          DEFAULT: '#3ddc97',
          bright: '#5ef0b0',
          dim: '#1f9e6a',
        },
        warn: '#ffb454',
        danger: '#ff6b6b',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      backgroundImage: {
        'grid-fade':
          'linear-gradient(to bottom, rgba(7,10,15,0) 0%, rgba(7,10,15,1) 85%)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.4s ease-out both',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
