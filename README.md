# SAP → FBR Digital Invoicing bridge

A local Electron desktop app that takes A/R Invoices already posted in **SAP
Business One**, registers them with the **FBR Digital Invoicing** system, and
writes the returned FBR invoice number (IRN) back onto the SAP document.

Staff keep working the way they do today — they post invoices in the SAP B1
client. This app picks up anything not yet registered, sends it to FBR, and
stamps the result back into SAP.

---

## How it works

```
SAP B1 Service Layer          this app                 FBR / PRAL gateway
─────────────────────         ────────────             ──────────────────
GET  /Invoices          →  list unregistered
GET  /Invoices(id)      →  map to FBR payload
GET  /BusinessPartners  →  (HS codes, UoM,
GET  /Items                  province, sale type)
                           ├─ POST validateinvoicedata  →  dry run
                           ├─ record "sending" locally
                           ├─ POST postinvoicedata      →  invoiceNumber (IRN)
                           ├─ record result locally  ← always before SAP
PATCH /Invoices(id)     ←  write IRN into U_FBR_IRN
```

### Why the local log is written before SAP

FBR registration is **not idempotent and not reversible**. Once FBR issues an
invoice number, that number is the only link between the SAP document and the
government filing. So every submission writes to `data/submissions.jsonl` at each
step, *before* SAP is touched. If the write-back fails, the IRN is still on disk
and the invoice appears as **“Write-back due”**, repairable from the Audit log
tab. Nothing is ever silently lost.

The same log guards against duplicate filings: a submission that was sent but
never got a response stays marked `sending`, and the app refuses to re-post it
until you confirm against the IRIS portal.

---

## Setup

### 1. Create the SAP user-defined fields

**Required before first use.** See [scripts/sap-udf-setup.md](scripts/sap-udf-setup.md)
for the exact field definitions — invoice UDFs (`U_FBR_IRN`, `U_FBR_Status`, …),
business-partner UDFs (province, registration type), and item UDFs (HS code, UoM,
sale type).

Restart the Service Layer afterwards so the fields appear in the OData metadata.

### 2. Install and run

```bash
npm install
npm start          # or: npm run dev  (opens DevTools)
```

### 3. Configure

Open **Settings** and fill in:

- **SAP Service Layer** — base URL (`https://<host>:50000`), company database,
  user, password. Leave *Accept self-signed certificate* ticked unless you have
  installed a trusted certificate.
- **FBR** — environment plus the sandbox and production bearer tokens from the
  IRIS portal (valid five years).
- **Seller** — your NTN/CNIC, business name, province, address, exactly as
  registered with FBR.
- **Mapping defaults** — default scenario ID (sandbox), sale type, UoM.

Press **Test SAP** and **Test FBR** in the title bar to confirm both ends before
touching any invoices.

Credentials are encrypted at rest with Electron `safeStorage` (Windows DPAPI) and
stored in `config/config.json`, which is git-ignored. If encryption is
unavailable the app tells you and keeps secrets in memory only — it never writes
a token to disk in plain text.

---

## Daily use

1. **Invoices** tab → set a date range → **Refresh**. Only invoices without an
   IRN are listed unless you tick *Show already registered*.
2. **Preview** shows the exact JSON that would be sent, plus any blocking
   problems (missing HS code, missing province, …) in plain language.
3. **Validate** dry-runs it against FBR's `validateinvoicedata` — registers
   nothing.
4. **Register** posts it, then writes `U_FBR_IRN`, `U_FBR_Status`, `U_FBR_Date`
   back to the SAP invoice.

Select multiple rows to validate or register in a batch; they are processed
sequentially and one failure does not stop the rest.

### Sandbox vs production

The environment badge in the title bar is amber for sandbox and red for
production. Switching to production requires an explicit confirmation, and each
production submission asks again — those filings are real and irreversible.

`scenarioId` is attached in sandbox only, as the spec requires. All 28 scenario
IDs (SN001–SN028) are in the settings dropdown.

---

## Tools tab

- **FBR reference data** — provinces, units of measure, document types,
  transaction types; HS code → valid UoM; registration type and Active Taxpayer
  (STATL) lookups for a given NTN.
- **SAP diagnostics** — download the Service Layer `$metadata` and fetch a raw
  invoice JSON. Use these to confirm the exact field names on *your* B1 build
  before going live (see the caveat below).

---

## Known caveat: line-level tax field names

Service Layer exposes line tax slightly differently across B1 versions and
localisations. The mapper tries `VatSum`, `TaxTotal`, `TaxSum`, `LineVatSum`,
`VATSum` in order, then falls back to deriving the amount from
`TaxPercentagePerRow`.

It also cross-checks the computed total against `DocTotal` and raises a warning
when they differ by more than 1. **If you see that warning, use Tools → Fetch raw
invoice JSON to find the real field name on your system** and confirm the
mapping before going live. This was written without access to your server
(`10.0.1.55` is on a different subnet from this machine), so it is the one part
that has not been verified against your actual data.

---

## Verifying without SAP or FBR

```bash
npm test
```

Runs 14 offline checks covering payload construction, tax derivation, the
missing-HS-code and unregistered-buyer guards, sandbox vs production scenario
handling, debit-note reference requirements, and all three FBR response shapes
(valid, header rejection, item-level rejection under a `00` envelope).

---

## Layout

```
src/main/
  main.js        Electron entry, IPC surface
  preload.js     the only renderer↔main bridge (context-isolated)
  http.js        node:https wrapper — self-signed certs, cookie handling
  sapClient.js   Service Layer: login, session renewal, invoices, PATCH
  fbrClient.js   FBR DI: post, validate, reference APIs, response interpretation
  mapper.js      SAP invoice → FBR payload
  sync.js        orchestration, duplicate guards, write-back repair
  config.js      config + encrypted secrets
  store.js       append-only JSONL audit log
src/renderer/    UI (no node access)
scripts/
  sap-udf-setup.md   SAP UDF definitions
  selftest.js        offline test suite
data/            audit log, app log, downloaded metadata (git-ignored)
```

## Reference

Built against **Technical Specification for DI API v1.12** (PRAL, 24-Jul-2025).

| | |
|---|---|
| Post (sandbox) | `https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb` |
| Post (production) | `https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata` |
| Validate (sandbox) | `https://gw.fbr.gov.pk/di_data/v1/di/validateinvoicedata_sb` |
| Validate (production) | `https://gw.fbr.gov.pk/di_data/v1/di/validateinvoicedata` |
| Reference APIs | `https://gw.fbr.gov.pk/pdi/v1/…`, `/pdi/v2/…`, `/dist/v1/…` |

Note that invoices are also required to carry the FBR Digital Invoicing logo and
a QR code (version 2.0, 1×1 inch) on the printed layout — that is a Crystal
Report / PLD change inside SAP, not something this app can do.
