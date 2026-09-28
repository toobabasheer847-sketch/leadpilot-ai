import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // Local network (IP access) ko allow karne ke liye
    port: 5174,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    env: {
      VITE_API_BASE_URL: 'http://api.test/api/v1',
    },
  },
});