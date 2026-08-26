import type { Config } from 'tailwindcss';

/**
 * Semantic tokens only — components never name a raw colour, so an
 * organization's branding can be applied by overriding CSS variables and the
 * whole workspace follows.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: 'rgb(var(--surface) / <alpha-value>)',
        'surface-raised': 'rgb(var(--surface-raised) / <alpha-value>)',
        'surface-sunken': 'rgb(var(--surface-sunken) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        text: 'rgb(var(--text) / <alpha-value>)',
        'text-muted': 'rgb(var(--text-muted) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-fg': 'rgb(var(--accent-fg) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
      },
      borderRadius: { sm: '6px', md: '10px', lg: '14px' },
      fontSize: {
        xs: ['12px', '1.45'],
        sm: ['13px', '1.45'],
        base: ['14px', '1.5'],
        lg: ['16px', '1.5'],
        xl: ['20px', '1.35'],
        '2xl': ['24px', '1.3'],
        '3xl': ['32px', '1.2'],
      },
      transitionDuration: { fast: '120ms', base: '200ms', slow: '320ms' },
    },
  },
  plugins: [],
};

export default config;
