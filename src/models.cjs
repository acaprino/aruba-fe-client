// src/models.cjs
// Pure-data mappers: Aruba `Item` envelope from advancedSearch -> `Fattura`
// shape, plus the Aruba date parser. No external dependencies.
//
// There are two mapper variants because the portal's two sides use
// asymmetric field names for the counterparty:
//
//   - Received (passive) Item:  Mittente      = counterparty (supplier)
//   - Sent (active)     Item:  Destinatario   = counterparty (customer)
//
// Both mappers produce the same Fattura shape, with a `direzione` discriminator
// ('passiva' | 'attiva') and unified `controparte_*` fields.

const Direzione = Object.freeze({
  PASSIVA: 'passiva',
  ATTIVA: 'attiva',
});

const StatoSDI = Object.freeze({
  CONSEGNATA: 'consegnata',
  ACCETTATA: 'accettata',
  RIFIUTATA: 'rifiutata',
  SCARTATA: 'scartata',
  MANCATA_CONSEGNA: 'mancata_consegna',
  DECORSI_TERMINI: 'decorsi_termini',
  NON_RECAPITABILE: 'non_recapitabile',
  SCONOSCIUTO: 'sconosciuto',
});

// Map of the Aruba numeric `Stato` field to our canonical SDI labels.
// Extend as new codes appear in real data.
const STATO_CODE_MAP = {
  1: StatoSDI.CONSEGNATA,
  2: StatoSDI.CONSEGNATA,
};

function statoFromCode(code) {
  if (code == null) return StatoSDI.SCONOSCIUTO;
  return STATO_CODE_MAP[code] || StatoSDI.SCONOSCIUTO;
}

// Parses the Aruba date format: "2026/05/13 19:48:54.0000+02:00".
function parseArubaDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return raw;
  const s = String(raw).trim();
  const tzMatch = s.match(/([+-]\d{2}:?\d{2})$/);
  const tz = tzMatch ? normalizeTz(tzMatch[1]) : '';
  const body = tzMatch ? s.slice(0, -tzMatch[1].length) : s;
  let core = body.replace(/\//g, '-').replace(' ', 'T');
  core = core.replace(/\.\d+/, '');
  const iso = core + tz;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeTz(tz) {
  if (/^[+-]\d{4}$/.test(tz)) return `${tz.slice(0, 3)}:${tz.slice(3)}`;
  return tz;
}

// Shared core mapper. Both toFattura and toFatturaSent funnel through this.
// `counterpartyName` is the Item field that carries the counterparty
// denomination ("Mittente" for passive, "Destinatario" for active). The
// CodicePrimario / CodiceSecondario fields hold the counterparty VAT and CF
// on both sides — Aruba consistently uses these as "the other party"
// regardless of direction.
function _toFatturaCore(item, direzione, counterpartyName) {
  if (!item || typeof item !== 'object' || !item.Id || !item.Numero || !item.Data) return null;
  const dataEmissione = parseArubaDate(item.Data);
  if (!dataEmissione) return null;

  const controparte = nullable(item[counterpartyName]);
  const controparte_piva = nullable(item.CodicePrimario);
  const controparte_cf = nullable(item.CodiceSecondario);

  return {
    id_aruba: String(item.Id),
    numero: String(item.Numero),
    data: ymd(dataEmissione),
    direzione,
    controparte,
    controparte_piva,
    controparte_cf,
    tipo_documento: nullable(item.Tipo),
    formato_trasmissione: nullable(item.FormatoTrasmissione),
    importo_totale: numNullable(item.TotaleDocumento),
    totale_imponibile: numNullable(item.TotaleImponibile),
    totale_iva: numNullable(item.TotaleIva),
    totale_non_imponibile: numNullable(item.TotaleNonImponibile),
    netto_a_pagare: numNullable(item.NettoAPagare),
    valuta: 'EUR',
    stato_sdi: statoFromCode(item.Stato),
    stato_code: typeof item.Stato === 'number' ? item.Stato : null,
    data_ricezione: parseArubaDate(item.DataRicezione)?.toISOString() || null,
    id_sdi: nullable(item.IdSdi),
    sdi_filename: nullable(item.SdiFileName),
    conservato: Boolean(item.Conservato),
    importata: Boolean(item.Importata),
    allegati: Boolean(item.Allegati),
  };
}

/**
 * Map a raw Item from `advancedSearch` (received / passive invoices) to a
 * Fattura with `direzione: 'passiva'`. Returns null on malformed input.
 */
function toFattura(item) {
  return _toFatturaCore(item, Direzione.PASSIVA, 'Mittente');
}

/**
 * Map a raw Item from `advancedSearchSent` (sent / active invoices) to a
 * Fattura with `direzione: 'attiva'`. Returns null on malformed input.
 *
 * The Aruba portal uses `Destinatario` as the counterparty denomination on
 * the sent tab; CodicePrimario / CodiceSecondario still hold the counterparty
 * VAT and CF.
 */
function toFatturaSent(item) {
  return _toFatturaCore(item, Direzione.ATTIVA, 'Destinatario');
}

function nullable(v) {
  return v == null || v === '' ? null : v;
}

function numNullable(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// YYYY-MM-DD in UTC. Local-tz would produce different results on servers
// running UTC vs. Europe/Rome dev boxes: an invoice timestamped
// "2026/01/01 02:30:00+02:00" would become "2025-12-31" on a UTC server and
// "2026-01-01" on dev, breaking year-bucket logic and date-range filters.
function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = {
  StatoSDI,
  Direzione,
  statoFromCode,
  parseArubaDate,
  toFattura,
  toFatturaSent,
};
