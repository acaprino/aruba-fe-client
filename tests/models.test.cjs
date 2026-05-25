// tests/models.test.cjs
// Coverage for the Item -> Fattura mapper and the Aruba date parser.
// These are pure-data transforms — no HTTP, no network.

const assert = require('node:assert/strict');

const { toFattura, parseArubaDate, statoFromCode, StatoSDI } = require('../src/models.cjs');

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`  PASS  ${label}`); pass += 1; },
    (err) => { console.error(`  FAIL  ${label}\n    ${err.message}`); fail += 1; }
  );
}

const RAW_ITEM = {
  Id: '6a04b9861234567890abcdef',
  Numero: 'F12345',
  Data: '2026/05/13 19:48:54.0000+02:00',
  Mittente: 'Wind Tre S.p.A.',
  CodicePrimario: 'IT12345678901',
  CodiceSecondario: 'CF-12345678901',
  Tipo: 'TD01',
  FormatoTrasmissione: 'FPR12',
  TotaleDocumento: 44.41,
  TotaleImponibile: 36.40,
  TotaleIva: 8.01,
  TotaleNonImponibile: 0,
  NettoAPagare: 44.41,
  Stato: 1,
  DataRicezione: '2026/05/14 09:00:00.0000+02:00',
  IdSdi: 'SDI-12345',
  SdiFileName: 'IT12345678901_00abc.xml',
  Conservato: true,
  Importata: false,
  Allegati: false,
};

(async () => {
  console.log('\n== parseArubaDate ==');

  await test('parses Aruba format with positive tz offset', () => {
    const d = parseArubaDate('2026/05/13 19:48:54.0000+02:00');
    assert.ok(d instanceof Date);
    assert.equal(d.getUTCHours(), 17);
    assert.equal(d.getUTCMinutes(), 48);
  });

  await test('parses Aruba format with compact tz (+0200)', () => {
    const d = parseArubaDate('2026/05/13 19:48:54.0000+0200');
    assert.ok(d instanceof Date);
    assert.equal(d.getUTCHours(), 17);
  });

  await test('returns null on empty/null input', () => {
    assert.equal(parseArubaDate(''), null);
    assert.equal(parseArubaDate(null), null);
    assert.equal(parseArubaDate(undefined), null);
  });

  await test('passes through Date instances', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    assert.equal(parseArubaDate(d), d);
  });

  console.log('\n== statoFromCode ==');

  await test('maps known codes to consegnata', () => {
    assert.equal(statoFromCode(1), StatoSDI.CONSEGNATA);
    assert.equal(statoFromCode(2), StatoSDI.CONSEGNATA);
  });

  await test('maps unknown / null to sconosciuto', () => {
    assert.equal(statoFromCode(999), StatoSDI.SCONOSCIUTO);
    assert.equal(statoFromCode(null), StatoSDI.SCONOSCIUTO);
    assert.equal(statoFromCode(undefined), StatoSDI.SCONOSCIUTO);
  });

  console.log('\n== toFattura ==');

  await test('maps a full Item to the Fattura shape', () => {
    const f = toFattura(RAW_ITEM);
    assert.ok(f);
    assert.equal(f.id_aruba, '6a04b9861234567890abcdef');
    assert.equal(f.numero, 'F12345');
    assert.equal(f.data, '2026-05-13'); // UTC YYYY-MM-DD
    assert.equal(f.mittente, 'Wind Tre S.p.A.');
    assert.equal(f.cedente_piva, 'IT12345678901');
    assert.equal(f.cedente_cf, 'CF-12345678901');
    assert.equal(f.tipo_documento, 'TD01');
    assert.equal(f.formato_trasmissione, 'FPR12');
    assert.equal(f.importo_totale, 44.41);
    assert.equal(f.totale_imponibile, 36.40);
    assert.equal(f.totale_iva, 8.01);
    assert.equal(f.valuta, 'EUR');
    assert.equal(f.stato_sdi, StatoSDI.CONSEGNATA);
    assert.equal(f.stato_code, 1);
    assert.equal(f.id_sdi, 'SDI-12345');
    assert.equal(f.conservato, true);
    assert.equal(f.importata, false);
  });

  await test('UTC ymd is stable across timezones (year-rollover guard)', () => {
    // Local-tz would put this on 2025-12-31 in UTC, 2026-01-01 in Europe/Rome.
    // The mapper must yield UTC-anchored 2025-12-31.
    const item = { ...RAW_ITEM, Data: '2026/01/01 02:30:00.0000+02:00' };
    const f = toFattura(item);
    assert.equal(f.data, '2026-01-01'); // 00:30 UTC -> 2026-01-01
    const item2 = { ...RAW_ITEM, Data: '2026/01/01 01:30:00.0000+02:00' };
    const f2 = toFattura(item2);
    assert.equal(f2.data, '2025-12-31'); // 23:30 UTC -> 2025-12-31
  });

  await test('returns null for items missing required fields', () => {
    assert.equal(toFattura(null), null);
    assert.equal(toFattura({}), null);
    assert.equal(toFattura({ Id: 'x', Numero: 'y' }), null); // no Data
    assert.equal(toFattura({ ...RAW_ITEM, Data: 'not-a-date' }), null);
  });

  await test('nullable / numNullable handle missing fields gracefully', () => {
    const minimal = { Id: 'x', Numero: 'y', Data: '2026/05/13 12:00:00+00:00' };
    const f = toFattura(minimal);
    assert.equal(f.mittente, null);
    assert.equal(f.cedente_piva, null);
    assert.equal(f.importo_totale, null);
    assert.equal(f.totale_iva, null);
  });

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
