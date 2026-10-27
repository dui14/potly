/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['Space Grotesk', 'sans-serif'],
        body: ['DM Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-strong': 'var(--surface-strong)',
        'surface-muted': 'var(--surface-muted)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        muted: 'var(--muted)',
        subtle: 'var(--subtle)',
        accent: 'var(--accent)',
        success: 'var(--success)',
        danger: 'var(--danger)',
      },
      borderColor: {
        DEFAULT: 'var(--border)',
        strong: 'var(--border-strong)',
      },
    },
  },
  plugins: [],
}
