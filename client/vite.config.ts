import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    // Same origin in development as in production, so no CORS is needed.
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:3000' },
  },
  test: { environment: 'jsdom' },
});
