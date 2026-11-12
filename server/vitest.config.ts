import { defineConfig } from 'vitest/config';

// A tesztfájlok ugyanazt a tesztadatbázist építik újra, ezért egymás után futnak.
export default defineConfig({ test: { fileParallelism: false } });
