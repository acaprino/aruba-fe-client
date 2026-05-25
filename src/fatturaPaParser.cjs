// src/fatturaPaParser.cjs
// Minimal FatturaPA v1.2 XML parser using cheerio (xmlMode). Targets only the
// fields needed to render a "what's in this invoice" view to a human:
//
//   - voci[]:    { numero_linea, descrizione, quantita, prezzo_unitario,
//                  prezzo_totale, aliquota_iva, data_inizio_periodo,
//                  data_fine_periodo }
//   - causale:   string | null   (DatiGeneraliDocumento/Causale)
//   - dati_pagamento: { modalita, scadenza, importo } | null
//                  (first DettaglioPagamento)
//
// CedentePrestatore / CessionarioCommittente / IVA breakdowns are deliberately
// ignored — those fields are already present in the metadata Item returned by
// advancedSearch and don't need to be re-extracted from the XML.

const cheerio = require('cheerio');

// FatturaPA uses the namespace "ns0:" or "p:" on the root element. Cheerio
// in xmlMode preserves the prefixes, so we strip them at parse time with a
// regex on the raw XML. Standard practice for FatturaPA scrapers.
function stripXmlNs(xml) {
  return String(xml || '')
    .replace(/<\?xml[^?]*\?>/g, '')
    .replace(/<([\/]?)[A-Za-z0-9]+:/g, '<$1')
    .replace(/xmlns(:[A-Za-z0-9]+)?="[^"]*"/g, '');
}

function numOrNull(s) {
  if (s == null || s === '') return null;
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function strOrNull(s) {
  const t = (s == null ? '' : String(s)).trim();
  return t || null;
}

/**
 * Parse a FatturaPA v1.2 XML string into the slim shape consumed by UIs.
 * Throws if the root element is missing — propagates as a "not a FatturaPA"
 * error.
 *
 * @param {string} xml  Decoded UTF-8 XML
 * @returns {{ voci: Array<object>, causale: string|null, dati_pagamento: object|null }}
 */
function parseFatturaPa(xml) {
  const $ = cheerio.load(stripXmlNs(xml), { xmlMode: true });

  const root = $('FatturaElettronica').first();
  if (root.length === 0) {
    throw new Error('fatturaPaParser: root <FatturaElettronica> not found');
  }

  const causale = strOrNull(
    $('FatturaElettronicaBody > DatiGenerali > DatiGeneraliDocumento > Causale').first().text()
  );

  const voci = [];
  $('FatturaElettronicaBody > DatiBeniServizi > DettaglioLinee').each((_, el) => {
    const $el = $(el);
    voci.push({
      numero_linea: numOrNull($el.children('NumeroLinea').text()),
      descrizione: strOrNull($el.children('Descrizione').text()),
      quantita: numOrNull($el.children('Quantita').text()),
      prezzo_unitario: numOrNull($el.children('PrezzoUnitario').text()),
      prezzo_totale: numOrNull($el.children('PrezzoTotale').text()),
      aliquota_iva: numOrNull($el.children('AliquotaIVA').text()),
      data_inizio_periodo: strOrNull($el.children('DataInizioPeriodo').text()),
      data_fine_periodo: strOrNull($el.children('DataFinePeriodo').text()),
    });
  });

  // First DettaglioPagamento under the first DatiPagamento block. Most
  // suppliers have a single payment line; multi-line splits are surfaced
  // upstream via a "multiple payments" UI hint if needed.
  const firstDp = $('FatturaElettronicaBody > DatiPagamento > DettaglioPagamento').first();
  const dati_pagamento = firstDp.length
    ? {
        modalita: strOrNull(firstDp.children('ModalitaPagamento').text()),
        scadenza: strOrNull(firstDp.children('DataScadenzaPagamento').text()),
        importo: numOrNull(firstDp.children('ImportoPagamento').text()),
      }
    : null;

  return { voci, causale, dati_pagamento };
}

module.exports = { parseFatturaPa, stripXmlNs };
