/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        space: {
          bg: '#080d1a',
          card: 'rgba(255,255,255,0.04)',
          border: 'rgba(255,255,255,0.08)',
          text: '#e2e8f0',
          muted: '#94a3b8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'radial-stars': 'radial-gradient(ellipse at top, #0f1a30 0%, #080d1a 70%)',
      },
    },
  },
  plugins: [],
}
