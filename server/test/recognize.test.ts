import { describe, expect, it } from 'vitest';
import { anchorRelativeDates, matchesName, recognize, type Span } from '../src/recognize.js';

// 2026-11-12 csütörtök
const today = '2026-11-12';
const people = [
  { id: 'szabi', names: ['Szabi', 'Szabolcs'] },
  { id: 'istvan', names: ['István'] },
  { id: 'geza', names: ['Géza'] },
];
const run = (text: string, knownTickets?: number[]) =>
  recognize(text, { today, people, knownTickets: new Set(knownTickets) });
const dates = (text: string) =>
  run(text).filter((s): s is Extract<Span, { kind: 'date' }> => s.kind === 'date').map((s) => [s.text, s.from, s.to]);
const one = (text: string) => dates(text).map(([, from, to]) => (from === to ? from : `${from}..${to}`));

describe('jegyszám', () => {
  it('a # előtagú szám jegy', () => {
    expect(run('a #1234 kész, a #56 vár')).toMatchObject([
      { kind: 'ticket', text: '#1234', ticketNo: 1234 },
      { kind: 'ticket', text: '#56', ticketNo: 56 },
    ]);
  });

  it('a puszta szám csak akkor jegy, ha már létezik ilyen jegy', () => {
    expect(run('1234 kész, 3 nap, 2026')).toEqual([]);
    expect(run('1234 kész, 3 nap, 2026', [1234])).toMatchObject([{ kind: 'ticket', text: '1234', ticketNo: 1234 }]);
  });

  it('a dátum része nem lesz jegy', () => {
    expect(run('11.20-ig', [11, 20]).map((s) => s.kind)).toEqual(['date']);
  });
});

describe('név', () => {
  it('ragozva is felismeri', () => {
    const text = 'Szabinak szóltam, Istvánnal egyeztet, Gézától várjuk, Szabolcs ráér';
    expect(run(text).map((s) => [s.text, s.kind === 'person' && s.personId])).toEqual([
      ['Szabinak', 'szabi'],
      ['Istvánnal', 'istvan'],
      ['Gézától', 'geza'],
      ['Szabolcs', 'szabi'],
    ]);
  });

  it('a kisbetűs "szabi" (szabadság) nem név, és más szó eleje sem az', () => {
    expect(run('jövőre szabi nincs, Szabina jön')).toMatchObject([]);
    expect(matchesName('Istvánka', 'István')).toBe(false);
  });

  it('ha két emberre is illik, nem dönt', () => {
    const spans = recognize('Péter jön', {
      today,
      people: [{ id: 'a', names: ['Péter'] }, { id: 'b', names: ['Péter'] }],
    });
    expect(spans).toEqual([]);
  });
});

describe('@név', () => {
  const tagged = (text: string) =>
    run(text).map((s) => (s.kind === 'person' ? [s.text, s.personId ?? `új:${s.newName}`] : [s.text, s.kind]));

  it('az ismert embert ragozva és kisbetűvel is felismeri, a @ is a kiemelés része', () => {
    expect(tagged('@Szabinak szóltam, @istvánnal egyeztet')).toEqual([
      ['@Szabinak', 'szabi'],
      ['@istvánnal', 'istvan'],
    ]);
  });

  it('ismeretlen névnél az alapalakot adja, ebből lesz az új ember', () => {
    expect(tagged('@Annának @Péterrel @Zoltán @Kornél @Bálint @dénesről')).toEqual([
      ['@Annának', 'új:Anna'],
      ['@Péterrel', 'új:Péter'],
      ['@Zoltán', 'új:Zoltán'],
      ['@Kornél', 'új:Kornél'],
      ['@Bálint', 'új:Bálint'],
      ['@dénesről', 'új:Dénes'],
    ]);
  });

  it('az e-mail cím nem név, és a @ nélküli felismerés is megmarad', () => {
    expect(tagged('írj a teszt@szabi.hu címre, Szabi tudja')).toEqual([['Szabi', 'szabi']]);
  });

  it('ha két emberre is illik, nem dönt és nem is hoz létre újat', () => {
    const spans = recognize('@Péter jön', {
      today,
      people: [{ id: 'a', names: ['Péter'] }, { id: 'b', names: ['Péter'] }],
    });
    expect(spans).toEqual([]);
  });
});

describe('többtagú név', () => {
  const people2 = [
    { id: 'matrai', names: ['Mátrai Peti'] },
    { id: 'gulyas', names: ['Gulyás Peti'] },
  ];
  const tagged = (text: string) =>
    recognize(text, { today, people: people2 }).map((s) =>
      s.kind === 'person' ? [s.text, s.personId ?? `új:${s.newName}`] : [s.text, s.kind],
    );

  it('a teljes nevet egyben ismeri fel, az utolsó tag ragozva is lehet; a közös tag magában nem dönt', () => {
    expect(tagged('Mátrai Petinek szóltam, Gulyás Peti ráér, Peti nem tudja, Mátrai igen')).toEqual([
      ['Mátrai Petinek', 'matrai'],
      ['Gulyás Peti', 'gulyas'],
      ['Mátrai', 'matrai'],
    ]);
  });

  it('@-tal is, a pill a teljes nevet fedi', () => {
    expect(tagged('@Mátrai Petivel és @gulyás Peti')).toEqual([
      ['@Mátrai Petivel', 'matrai'],
      ['@gulyás Peti', 'gulyas'],
    ]);
  });

  it('az ismeretlen @név a következő nagybetűs szavakkal együtt új ember, legfeljebb három tagig', () => {
    expect(tagged('@Kiss Anna Máriának szólt, @Ákos FDD tréninget tart, @Egy Kettő Három Négy')).toEqual([
      ['@Kiss Anna Máriának', 'új:Kiss Anna Mária'],
      ['@Ákos', 'új:Ákos'],
      ['@Egy Kettő Három', 'új:Egy Kettő Három'],
    ]);
  });

  it('ha a @ után hosszabb név áll, mint az ismert, új ember lesz; sortörésen át nem fűz össze', () => {
    expect(tagged('@Mátrai Gergő jön')).toEqual([['@Mátrai Gergő', 'új:Mátrai Gergő']]);
    // A teljes ismert név viszont nyer: a mögötte álló nagybetűs szó nem a név része.
    expect(tagged('@Mátrai Petinek Gulyás Peti szólt')).toEqual([
      ['@Mátrai Petinek', 'matrai'],
      ['Gulyás Peti', 'gulyas'],
    ]);
    // A két Petire illő „@Peti” nem hoz létre harmadikat.
    expect(tagged('@Peti mondta')).toEqual([]);
    expect(tagged('@Ákos\nMátrai')).toEqual([
      ['@Ákos', 'új:Ákos'],
      ['Mátrai', 'matrai'],
    ]);
  });
});

describe('dátum', () => {
  it('évvel és év nélkül', () => {
    expect(one('2026-11-20')).toEqual(['2026-11-20']);
    expect(one('2026.11.20.')).toEqual(['2026-11-20']);
    expect(one('nov. 20')).toEqual(['2026-11-20']);
    expect(one('november 20-án')).toEqual(['2026-11-20']);
    expect(one('11.20')).toEqual(['2026-11-20']);
    expect(one('11.20-ig')).toEqual(['2026-11-20']);
    expect(one('3.5-én')).toEqual(['2027-03-05']);
  });

  it('év nélkül a legközelebbi előfordulást veszi', () => {
    expect(one('jan 8')).toEqual(['2027-01-08']);
    expect(one('10.28.')).toEqual(['2026-10-28']);
  });

  it('a tizedes tört, a verziószám és az érvénytelen nap nem dátum', () => {
    expect(one('1.5 nap, v1.2.3, 13.45, 02.30')).toEqual([]);
  });

  it('a hét napjai', () => {
    expect(one('pénteken beadja')).toEqual(['2026-11-13']);
    expect(one('csütörtök')).toEqual(['2026-11-12']); // a mai nap is számít
    expect(one('szerdán')).toEqual(['2026-11-18']);
    expect(one('jövő kedd')).toEqual(['2026-11-17']);
    expect(one('jövő héten pénteken')).toEqual(['2026-11-20']);
    expect(one('múlt hétfőn')).toEqual(['2026-11-02']);
  });

  it('relatív kifejezések', () => {
    expect(one('ma')).toEqual(['2026-11-12']);
    expect(one('holnapra')).toEqual(['2026-11-13']);
    expect(one('holnapután')).toEqual(['2026-11-14']);
    expect(one('tegnap')).toEqual(['2026-11-11']);
    expect(one('2 hét múlva')).toEqual(['2026-11-26']);
    expect(one('3 nap múlva')).toEqual(['2026-11-15']);
    expect(one('jövő héten')).toEqual(['2026-11-16..2026-11-22']);
    expect(one('20-án')).toEqual(['2026-11-20']);
    expect(one('5-ig')).toEqual(['2026-12-05']);
  });

  it('a "ma" csak önálló szóként dátum', () => {
    expect(one('maradt a forma, mai')).toEqual([]);
  });

  it('időszak, évfordulón át is', () => {
    expect(one('dec 22–jan 2')).toEqual(['2026-12-22..2027-01-02']);
    expect(one('12.22-01.02')).toEqual(['2026-12-22..2027-01-02']);
    expect(one('hétfő - szerda')).toEqual(['2026-11-16..2026-11-18']);
  });

  it('a találat pontosan a szövegrészt jelöli', () => {
    expect(dates('Szabi nov. 20-ig szabin')).toEqual([['nov. 20', '2026-11-20', '2026-11-20']]);
  });
});

describe('relatív dátum kiegészítése', () => {
  const anchor = (text: string) => anchorRelativeDates(text, today);

  it('a relatív dátum elé a pontos dátum kerül, időszaknál a két végpont', () => {
    expect(anchor('csütörtökön később kezd')).toBe('2026-11-12 csütörtökön később kezd');
    expect(anchor('holnap beadja, jövő héten szabin')).toBe('2026-11-13 holnap beadja, 2026-11-16–2026-11-22 jövő héten szabin');
    expect(anchor('20-án kész, 3 nap múlva')).toBe('2026-11-20 20-án kész, 2026-11-15 3 nap múlva');
  });

  it('az év nélküli dátumot is kiegészíti', () => {
    expect(anchor('december 10-én kész')).toBe('2026-12-10 december 10-én kész');
    expect(anchor('nov. 20-ig, 11.20')).toBe('2026-11-20 nov. 20-ig, 2026-11-20 11.20');
    expect(dates('2026-12-10 december 10-én')).toEqual([['2026-12-10 december 10', '2026-12-10', '2026-12-10']]);
  });

  it('az évvel megadott dátumhoz nem nyúl, és másodszorra sem ír elé', () => {
    for (const t of ['2026-11-20', '2026.11.20. kész', 'semmi dátum']) expect(anchor(t)).toBe(t);
    const once = anchor('csütörtökön később kezd');
    expect(anchor(once)).toBe(once);
  });

  it('a kiegészített dátum egy kiemelés', () => {
    expect(dates('2026-11-12 csütörtökön később kezd')).toEqual([['2026-11-12 csütörtökön', '2026-11-12', '2026-11-12']]);
    expect(dates('2026-11-16–2026-11-22 jövő héten')).toEqual([
      ['2026-11-16–2026-11-22 jövő héten', '2026-11-16', '2026-11-22'],
    ]);
  });
});

describe('vegyes sor', () => {
  it('egy papírra firkált sorból mindhármat kiveszi', () => {
    const spans = run('Szabi a #1234-et pénteken beadja, utána Istvánra várunk');
    expect(spans.map((s) => s.kind)).toEqual(['person', 'ticket', 'date', 'person']);
  });
});
