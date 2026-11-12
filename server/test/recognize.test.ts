import { describe, expect, it } from 'vitest';
import { matchesName, recognize, type Span } from '../src/recognize.js';

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

describe('vegyes sor', () => {
  it('egy papírra firkált sorból mindhármat kiveszi', () => {
    const spans = run('Szabi a #1234-et pénteken beadja, utána Istvánra várunk');
    expect(spans.map((s) => s.kind)).toEqual(['person', 'ticket', 'date', 'person']);
  });
});
