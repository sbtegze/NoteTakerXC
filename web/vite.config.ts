import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Fejlesztés közben (npm run dev:web) az API-hívások a helyben futó szerverhez mennek.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
