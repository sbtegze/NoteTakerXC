import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// A többi parancshoz hasonlóan a tesztek is a repó gyökerében lévő .env fájlból olvasnak.
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// A szervertesztek mindkét adatbázismotoron lefutnak: a JSON-on mindig (ideiglenes fájlban), a Postgresen
// akkor, ha a TEST_DATABASE_URL be van állítva. A Postgres-tesztfájlok ugyanazt az adatbázist építik újra,
// ezért egymás után futnak.
export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: { name: 'json', env: { TEST_DB_ENGINE: 'json' }, exclude: ['**/node_modules/**', 'test/schema.test.ts'] },
      },
      ...(process.env.TEST_DATABASE_URL
        ? [
            {
              extends: true,
              test: {
                name: 'postgres',
                env: { TEST_DB_ENGINE: 'postgres' },
                exclude: ['**/node_modules/**', 'test/recognize.test.ts', 'test/json-db.test.ts'],
              },
            },
          ]
        : []),
    ],
  },
});
