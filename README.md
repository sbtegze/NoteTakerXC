# NoteTakerXC

Vizuális jegyzetelő: bármelyik node középre állítható, körülötte csoportosul minden, ami kapcsolódik hozzá.
Rögzítéskor csak szöveget írsz; a jegyszámot (`#1234`), a neveket és a dátumokat a program ismeri fel.

## Indítás helyben

1. Hozz létre két PostgreSQL adatbázist: `notetaker` és `notetaker_test`.
2. Másold a `.env.example` fájlt `.env` néven, és írd át a kapcsolati adatokat.
3. `npm install`
4. `npm run create-user -- <e-mail> "<név>" <jelszó>` (a jelszó legalább 10 karakter)
5. `npm run dev:server`

A migrációk a szerver indításakor maguktól lefutnak.

## Tesztek

`npm test`

A tesztek a `TEST_DATABASE_URL` adatbázist minden futáskor **törlik és újraépítik**, ezért annak a nevében
szerepelnie kell a `test` szónak.

## Felépítés

- `db/migrations/` – a séma, sorszámozott SQL fájlokban
- `server/src/recognize.ts` – jegyszám, név és dátum felismerése szabad szövegből
- `server/src/nodes.ts` – rögzítés és szerkesztés, a felismert kapcsolatok mentése
- `server/src/auth.ts`, `app.ts` – bejelentkezés és az API

## API (eddig)

| Hívás | Leírás |
|---|---|
| `POST /api/login`, `POST /api/logout`, `GET /api/me` | Bejelentkezés |
| `POST /api/nodes` | Új node: `content`, opcionálisan `parentId`, `contextId`, `type`, `aliases` |
| `PATCH /api/nodes/:id` | Szerkesztés: `content`, `version` (ütközésnél 409) |
