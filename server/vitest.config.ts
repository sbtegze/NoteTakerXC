import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// A többi parancshoz hasonlóan a tesztek is a repó gyökerében lévő .env fájlból olvasnak.
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// A tesztfájlok ugyanazt a tesztadatbázist építik újra, ezért egymás után futnak.
export default defineConfig({ test: { fileParallelism: false } });
