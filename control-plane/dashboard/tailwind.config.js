/** @type {import('tailwindcss').Config} */
// Console palette (docs: stratum/CONSOLE-UX.md prototype). Pages use these
// names, never raw colors, so the look changes here.
module.exports = {
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Surfaces
        app:     '#f6f7f9',   // page background
        card:    '#ffffff',   // cards, dialogs
        raised:  '#f3f5f8',   // hovered rows, inputs at rest
        nav:     '#eef0f3',   // sidebar

        // Borders
        border:          '#e3e6eb',
        'border-strong': '#c9ced6',

        // Text, darkest to lightest (all ≥ 4.5:1 on white)
        strong:  '#161a22',
        default: '#2b313c',
        muted:   '#5b6472',
        subtle:  '#6b7380',

        // Primary actions
        ink: { DEFAULT: '#161a22', hover: '#2b313c' },

        // Links, focus, selection
        accent: {
          DEFAULT: '#2448b8',
          hover:   '#16307f',
          light:   '#e8eefc',
          text:    '#2448b8',
        },

        // Semantic
        ok:    { DEFAULT: '#17703f', light: '#e7f4ec' },
        err:   { DEFAULT: '#a8261b', light: '#fbeae8' },
        warn:  { DEFAULT: '#8a5300', light: '#fbf1e0' },
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(22,26,34,.04)',
        dropdown: '0 8px 28px rgba(22,26,34,.12)',
      },
    },
  },
  plugins: [],
}
