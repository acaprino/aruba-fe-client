// tests/fatturaPaParser.test.cjs
// Verifies parseFatturaPa() extracts DettaglioLinee, Causale, and the first
// DettaglioPagamento block from a representative FatturaPA v1.2 XML.
// The fixture mirrors what was captured live from Aruba's
// ExtractXmlInvoiceReceived endpoint.

const assert = require('node:assert/strict');

const { parseFatturaPa, stripXmlNs } = require('../src/fatturaPaParser.cjs');

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`  PASS  ${label}`); pass += 1; },
    (err) => { console.error(`  FAIL  ${label}\n    ${err.message}`); fail += 1; }
  );
}

const FIXTURE_WINDTRE = `<?xml version="1.0" encoding="UTF-8" ?>
<ns0:FatturaElettronica versione="FPR12" xmlns:ns0="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <FatturaElettronicaHeader>
    <CedentePrestatore>
      <DatiAnagrafici>
        <Anagrafica><Denominazione>Wind Tre S.p.A.</Denominazione></Anagrafica>
      </DatiAnagrafici>
    </CedentePrestatore>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Data>2026-05-12</Data>
        <Numero>F2613186838</Numero>
        <ImportoTotaleDocumento>44.41</ImportoTotaleDocumento>
        <Causale>Wind Tre S.p.A. con Socio Unico</Causale>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee>
        <NumeroLinea>1</NumeroLinea>
        <Descrizione>Abbonamento Super Fibra Professional</Descrizione>
        <Quantita>1.00</Quantita>
        <PrezzoUnitario>23.00</PrezzoUnitario>
        <PrezzoTotale>23.00</PrezzoTotale>
        <AliquotaIVA>22.00</AliquotaIVA>
      </DettaglioLinee>
      <DettaglioLinee>
        <NumeroLinea>2</NumeroLinea>
        <Descrizione>Canone InVista</Descrizione>
        <Quantita>1.00</Quantita>
        <PrezzoUnitario>2.00</PrezzoUnitario>
        <PrezzoTotale>2.00</PrezzoTotale>
        <AliquotaIVA>22.00</AliquotaIVA>
        <DataInizioPeriodo>2026-05-01</DataInizioPeriodo>
        <DataFinePeriodo>2026-05-31</DataFinePeriodo>
      </DettaglioLinee>
    </DatiBeniServizi>
    <DatiPagamento>
      <DettaglioPagamento>
        <ModalitaPagamento>MP05</ModalitaPagamento>
        <DataScadenzaPagamento>2026-06-15</DataScadenzaPagamento>
        <ImportoPagamento>44.41</ImportoPagamento>
      </DettaglioPagamento>
    </DatiPagamento>
  </FatturaElettronicaBody>
</ns0:FatturaElettronica>`;

const FIXTURE_NO_VOCI = `<?xml version="1.0" encoding="UTF-8" ?>
<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">
  <FatturaElettronicaHeader/>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento/>
    </DatiGenerali>
    <DatiBeniServizi/>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;

(async () => {
  console.log('\n== parseFatturaPa ==');

  await test('strips xml prolog and ns prefixes', () => {
    const stripped = stripXmlNs(FIXTURE_WINDTRE);
    assert.ok(!stripped.includes('<?xml'), 'prolog removed');
    assert.ok(!stripped.includes('ns0:'), 'ns prefix removed');
    assert.ok(stripped.includes('<FatturaElettronica'), 'root tag preserved');
  });

  await test('extracts both DettaglioLinee with full fields', () => {
    const r = parseFatturaPa(FIXTURE_WINDTRE);
    assert.equal(r.voci.length, 2);
    assert.equal(r.voci[0].numero_linea, 1);
    assert.equal(r.voci[0].descrizione, 'Abbonamento Super Fibra Professional');
    assert.equal(r.voci[0].quantita, 1);
    assert.equal(r.voci[0].prezzo_unitario, 23);
    assert.equal(r.voci[0].prezzo_totale, 23);
    assert.equal(r.voci[0].aliquota_iva, 22);
    assert.equal(r.voci[0].data_inizio_periodo, null);
    assert.equal(r.voci[1].descrizione, 'Canone InVista');
    assert.equal(r.voci[1].data_inizio_periodo, '2026-05-01');
    assert.equal(r.voci[1].data_fine_periodo, '2026-05-31');
  });

  await test('extracts Causale', () => {
    const r = parseFatturaPa(FIXTURE_WINDTRE);
    assert.equal(r.causale, 'Wind Tre S.p.A. con Socio Unico');
  });

  await test('extracts first DettaglioPagamento', () => {
    const r = parseFatturaPa(FIXTURE_WINDTRE);
    assert.deepEqual(r.dati_pagamento, {
      modalita: 'MP05',
      scadenza: '2026-06-15',
      importo: 44.41,
    });
  });

  await test('handles XML with no voci (empty array, not throw)', () => {
    const r = parseFatturaPa(FIXTURE_NO_VOCI);
    assert.deepEqual(r.voci, []);
    assert.equal(r.causale, null);
    assert.equal(r.dati_pagamento, null);
  });

  await test('handles "p:" namespace prefix variant', () => {
    const r = parseFatturaPa(FIXTURE_NO_VOCI);
    assert.ok(r);
  });

  await test('throws on malformed XML (no FatturaElettronica root)', () => {
    assert.throws(() => parseFatturaPa('<foo/>'), /root <FatturaElettronica> not found/);
  });

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
