import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // Deterministic date rendering in snapshots (CI also runs in UTC).
    env: { TZ: 'UTC' },
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Pages build their synthetic datasets at module load; give the first import room.
    testTimeout: 60_000,
  },
})
