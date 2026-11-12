# NoteTakerXC

Vizuális jegyzetelő: bármelyik node középre állítható, körülötte csoportosul minden, ami kapcsolódik hozzá.
Rögzítéskor csak szöveget írsz; a jegyszámot (`#1234`), a neveket és a dátumokat a program ismeri fel.

## Indítás helyben

1. Hozz létre két PostgreSQL adatbázist: `notetaker` és `notetaker_test`; az alkalmazás felhasználója legyen a tulajdonosuk.
2. Másold a `.env.example` fájlt `.env` néven a repó gyökerébe, és írd át a kapcsolati adatokat.
3. `npm install`
4. `npm run create-user` – bekéri az e-mailt, a nevet és a jelszót (legalább 10 karakter)
5. `npm run build` – lefordítja a felületet
6. `npm start`, majd nyisd meg: http://localhost:3000

**Frissítés és indítás egy lépésben:** `npm run up` (vagy dupla kattintás a `start.cmd` fájlra; Ctrl+C kérdés nélkül leállítja). Ez letölti a
legfrissebb változatot, telepíti a függőségeket, lefordítja a felületet, és elindítja a szervert.
A migrációk a szerver indításakor maguktól lefutnak.

Fejlesztéshez két terminálban `npm run dev:server` és `npm run dev:web` (ez utóbbi a http://localhost:5173 címen
fut, és mentéskor azonnal frissül).

## Használat

- **Rögzítés:** a középen álló node alatti mezőbe írsz, Enter ment. A `#1234`, a nevek és a dátumok maguktól kiemelődnek.
- **Középre állítás:** bármelyik címkére vagy kiemelt szövegrészre kattintva az áll középre. Fent az útvonal visszavisz.
- **Keresés:** Ctrl+K. Ha nincs találat, az Enter új node-ot hoz létre a Bejövő alá.
- **Emberek:** hozz létre egy node-ot a névvel, és állítsd a típusát „Ember”-re. Utána a szövegekben ragozva is felismeri.
- **Meeting:** a „Megnyitás meetingként” után minden új bejegyzés a meetinghez is kapcsolódik, bárhová írod.

## Tesztek

`npm test`

A tesztek a `TEST_DATABASE_URL` adatbázist minden futáskor **törlik és újraépítik**, ezért annak a nevében
szerepelnie kell a `test` szónak.

## Felépítés

- `db/migrations/` – a séma, sorszámozott SQL fájlokban
- `server/src/recognize.ts` – jegyszám, név és dátum felismerése szabad szövegből
- `server/src/nodes.ts` – rögzítés és szerkesztés, a felismert kapcsolatok mentése
- `server/src/auth.ts`, `app.ts` – bejelentkezés és az API
- `web/src/` – a böngészős felület (React)

## API (eddig)

| Hívás | Leírás |
|---|---|
| `POST /api/login`, `POST /api/logout`, `GET /api/me` | Bejelentkezés |
| `POST /api/nodes` | Új node: `content`, opcionálisan `parentId`, `contextId`, `type`, `aliases` |
| `PATCH /api/nodes/:id` | Szerkesztés: `version` (ütközésnél 409), és `content`, `type` vagy `aliases` |
| `GET /api/nodes/:id` | A node és a környezete: szülők, bejegyzések, kapcsolódó node-ok |
| `GET /api/search?q=` | Keresés |
| `GET /api/home` | A kezdőpont (Bejövő) azonosítója |
