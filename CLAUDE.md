# NoteTakerXC – tudnivalók a munkához

Vizuális jegyzetelő fejlesztői egyeztetésekhez. A felhasználó magyarul kommunikál; a felület, a hibaüzenetek,
a kódkommentek és a commit üzenetek is magyarok.

## Mire való

A felhasználó technical architect, heti két csoportos és eseti egyéni egyeztetést vezet öt fejlesztővel. Egyedül
jegyzetel. A cél, hogy Azure DevOps jegyekre és felvetett kérdésekre visszakereshető legyen:

- mit beszéltek meg, mi történik most, kire várnak, ki dolgozik rajta aktívan, mikor lesz kész;
- fejlesztőnként: min dolgozik, mi a következő feladata, mit fejezett be, mikor ad be munkát, mikor kell neki új
  feladat, mikor nem elérhető.

Ez a hét kérdés az MVP mércéje: valódi meetingek után mindegyikre legfeljebb két kattintással kell választ kapni.

## Lezárt döntések

- **Rögzítés:** a felhasználó csak szöveget ír, ahogy papírra firkálna. Nincs kitöltendő mező, tag vagy
  kapcsolattípus. A program ismeri fel a jegyszámot, a nevet és a dátumot.
- **A szöveg az elsődleges:** az említések (`mention` kapcsolat) és a dátumok (`node_dates`) származtatott adatok,
  szerkesztéskor újraszámolódnak. A kézzel megerősített dátumot (`confirmed`) az újraszámolás nem írja felül.
- **Jegyszám:** `#1234`. A `#` nélküli szám csak akkor jegy, ha már létezik ilyen jegy node. Azure DevOps
  integráció nem kell.
- **Név:** csak nagybetűs szó lehet név (a kisbetűs „szabi” szabadságot jelent). Ragozott alakot is felismer.
  A `@név` mindig név (kisbetűvel is); ha még nincs ilyen ember, létrehozza, mint a `#1234` a jegyet. Ismeretlen
  névnél csak a hosszabb ragot vágja le (`@Gézának` → Géza), a rövidet (-t, -n, -ra, -nál) nem, mert az gyakran
  a név része (Bálint, Zoltán, Klára, Kornél). A kommentben a `@név` sem hoz létre embert.
  Többtagú név (Mátrai Peti): egészben ismeri fel, csak az utolsó tag ragozott; a tagjai külön is jelentik az
  embert, ha csak egyre illenek (két Petinél a „Peti” magában nem dönt). Az ismeretlen `@név` mögötti nagybetűs,
  nem csupa nagybetűs szavak is a névhez tartoznak, legfeljebb három tagig (`@Ákos FDD` → Ákos); az ismert
  teljes név ennél erősebb.
- **Dátum:** év nélkül a rögzítés napjához legközelebbi előfordulás. A relatív dátum a node `created_at` napjához
  képest értendő.
- **Tag = node:** nincs külön tag vagy csoport; az ember, a jegy, a meeting is node, `type` mezővel.
- **Egy közös térkép**, munkaterületek nélkül. A node és a kapcsolat mindig közös.
- **Komment:** a `notes` tábla, pontosan egy node-hoz tartozik. Most minden publikus; a `visibility` mező a
  későbbi privát jegyzethez van fenntartva. A kommentben a felismerés csak kiemel, kapcsolatot nem hoz létre.
- **Jogosultság:** egyelőre nincs. Bejelentkezés kell, mert internet felé nyitott VPS-en fog futni.
- **Napló:** minden változást az adatbázis triggerei írnak a `change_log` táblába; nem módosítható.
- **Node törlése:** csak az a node törölhető, amelynek egyetlen kapcsolata a szülője felé mutat, és nincs élő
  kommentje (a Bejövő soha). Kuka ikon, megerősítés, utána fizikai törlés; a felületről nincs visszaállítás,
  de a napló „remove” sora megőrzi a régi állapotot.
- **Nem kell az MVP-be:** élő frissítés, AI-javaslatok, TipTap, gráfkönyvtár, natív app.

## Állapot

Kész:

1. Projektváz, séma, bejelentkezés
2. Rögzítés és felismerés (jegyszám, név, dátum)
3. Felület: középre állítás, útvonal, keresés, rögzítés, szerkesztés, típus és becenév, nyitott meeting
4. Kommentek a node-okon: a középen álló node-on és minden bejegyzésen; írás, szerkesztés, törlés
   (`deleted_at`). A felismert név, jegy, dátum kiemelt és kattintható, de kapcsolat nem jön létre.

Hátravan, ebben a sorrendben:

5. Fejlesztő- és csapatnézet szerep szerinti csoportokkal: Most, Következő, Várunk rá, Kész (`edges.role`)
6. Jelentésjavaslatok kulcsszavakból: a dátum határidő vagy távollét (`node_dates.meaning`), és a szerepek.
   Javaslat, egy kattintással javítható; cserélhető értelmezővel, hogy később nyelvi modell is lehessen.
7. Napló nézet (az egy tranzakcióból eredő sorok a `tx_id` alapján összevonhatók)
8. Rendezés húzással
9. Két hét valódi használat, a hét kérdéssel mérve

## Parancsok

- `npm run up` vagy `start.cmd` – telepítés, fordítás, indítás (http://localhost:3000); `git pull` nincs benne
- `npm test` – szervertesztek; a `TEST_DATABASE_URL` adatbázist minden futáskor törli és újraépíti
- `npm run typecheck` – szerver és felület
- `npm run dev:server`, `npm run dev:web` – fejlesztés közben (a felület a http://localhost:5173 címen)
- `npm run create-user` – felhasználó létrehozása vagy jelszócsere

A `.env` a repó gyökerében van (minta: `.env.example`). Helyben PostgreSQL 16 fut, a `notetaker_app`
felhasználó a `notetaker` és a `notetaker_test` adatbázis tulajdonosa.

## Munkamódszer

- Minden lépéshez teszt tartozik; a felületet valódi böngészőben is végig kell próbálni (Playwright).
- A séma változása új, sorszámozott fájl a `db/migrations/` mappában; a már lefutott migrációt nem írjuk át.
- A felhasználó rövid, gyakori állapotjelentést vár, és nem szeret kézzel parancsokat futtatni.
