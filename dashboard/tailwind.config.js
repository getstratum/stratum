/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        // App surfaces
        app:     '#f3f4f6',   // page background
        card:    '#ffffff',   // cards, sidebar
        raised:  '#f9fafb',   // elevated rows, inputs

        // Borders
        border:        '#e5e7eb',
        'border-strong':'#d1d5db',

        // Text hierarchy
        strong:  '#111827',
        default: '#374151',
        muted:   '#6b7280',
        subtle:  '#9ca3af',

        // Violet accent
        accent: {
          DEFAULT: '#7c3aed',
          hover:   '#6d28d9',
          light:   '#ede9fe',
          text:    '#6d28d9',
        },

        // Semantic
        ok:    { DEFAULT: '#059669', light: '#d1fae5' },
        err:   { DEFAULT: '#dc2626', light: '#fee2e2' },
        warn:  { DEFAULT: '#d97706', light: '#fef3c7' },
      },
      boxShadow: {
        card: '0 1px 3px 0 rgba(0,0,0,.06), 0 1px 2px -1px rgba(0,0,0,.04)',
        dropdown: '0 4px 24px rgba(0,0,0,.08)',
      },
    },
  },
  plugins: [],
}
