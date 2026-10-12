/** @type {import('tailwindcss').Config} */

// Graphite ramp replaces Tailwind's slate/gray so existing utility classes
// pick up the Analytics Hub palette automatically. Keep in sync with src/theme.ts.
const graphite = {
  50: '#eef2f6',
  100: '#e4eaf1',
  200: '#cfd7e0',
  300: '#d6dde5',
  400: '#c6ced8',
  500: '#9aa5b1',
  600: '#77828f',
  700: '#2a333d',
  800: '#18202a',
  900: '#0b0f14',
  950: '#07090c',
}

const glacier = {
  50: '#eef7fb',
  100: '#dcedf6',
  200: '#bfe0ef',
  300: '#a9d2e8',
  400: '#86c0de',
  500: '#6aa9cc',
  600: '#4f8db2',
  700: '#3f7699',
  800: '#2d5672',
  900: '#1a2a38',
  950: '#111c26',
}

export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        slate: graphite,
        gray: graphite,
        blue: glacier,
        sky: glacier,
        ink: {
          0: '#07090c',
          1: '#0b0f14',
          2: '#10161d',
          3: '#18202a',
        },
        fg: {
          1: '#e4eaf1',
          2: '#c6ced8',
          3: '#9aa5b1',
          4: '#77828f',
        },
        accent: '#86c0de',
        pos: '#6fc2a2',
        neg: '#e2826f',
        warn: '#d6ad66',
        hairline: 'rgba(150,178,205,0.09)',
        // Legacy alias kept for any remaining references
        space: {
          bg: '#07090c',
          card: 'rgba(200,220,240,0.035)',
          border: 'rgba(150,178,205,0.09)',
          text: '#e4eaf1',
          muted: '#c6ced8',
        },
      },
      fontFamily: {
        sans: ['Geist', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
      backgroundImage: {
        'radial-stars': 'none',
      },
    },
  },
  plugins: [],
}
