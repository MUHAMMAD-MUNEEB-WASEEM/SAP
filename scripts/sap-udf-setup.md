# SAP Business One — user-defined fields required by the FBR bridge

Create these **before** running the app. Without them the Service Layer `$select`
and `PATCH` calls fail with `Property 'U_FBR_IRN' does not exist`.

In the SAP B1 client: **Tools → Customisation Tools → User-Defined Fields — Management**.
After adding fields you must restart the Service Layer (or wait for its metadata
cache to refresh) before they appear in the OData feed.

---

## 1. Marketing Documents → Title (table `OINV`)

Path in the UDF manager: `Marketing Documents` → `Title`

| Field name (`U_` is added by SAP) | Description | Type | Length | Notes |
|---|---|---|---|---|
| `FBR_IRN` | FBR invoice number | Alphanumeric | 40 | The IRN written back after registration |
| `FBR_Status` | FBR status | Alphanumeric | 20 | `Valid` / `Invalid` |
| `FBR_Date` | FBR registration date | Date | — | Date FBR issued the number |
| `FBR_Message` | FBR message | Alphanumeric | 254 | Rejection reason, if any |
| `FBR_ScenarioId` | Sandbox scenario ID | Alphanumeric | 10 | Optional per-document override |
| `FBR_InvoiceType` | FBR invoice type | Alphanumeric | 30 | Optional; `Sale Invoice` or `Debit Note` |
| `FBR_RefNo` | Original FBR invoice no. | Alphanumeric | 40 | **Mandatory for debit notes** |

> `FBR_IRN` should be set read-only for ordinary users. It is the link to a
> government filing and must not be edited by hand.

## 2. Business Partners (table `OCRD`)

Path: `Business Partners` → `Title`

| Field name | Description | Type | Length | Notes |
|---|---|---|---|---|
| `FBR_Province` | FBR province | Alphanumeric | 30 | Use a valid value list (see below) |
| `FBR_RegType` | Registration type | Alphanumeric | 15 | `Registered` / `Unregistered` |

The buyer NTN/CNIC is read from the standard **Federal Tax ID** field
(`OCRD.LicTradNum`, exposed by Service Layer as `FederalTaxID`). Populate that
rather than adding another UDF. If your site keeps it elsewhere, change
**Settings → SAP user-defined field names → BP — NTN/CNIC**.

Valid FBR province values (from reference API `/pdi/v1/provinces`):

```
Punjab
Sindh
Khyber Pakhtunkhwa
Balochistan
Capital Territory
Gilgit Baltistan
Azad Jammu and Kashmir
```

## 3. Items (table `OITM`)

Path: `Master Data` → `Items`

| Field name | Description | Type | Length | Notes |
|---|---|---|---|---|
| `FBR_HSCode` | HS code | Alphanumeric | 15 | e.g. `0101.2100` |
| `FBR_UOM` | FBR unit of measure | Alphanumeric | 50 | Must match `/pdi/v1/uom`, e.g. `Numbers, pieces, units` |
| `FBR_SaleType` | Sale type | Alphanumeric | 60 | e.g. `Goods at standard rate (default)` |

Each HS code only permits certain units of measure. Use **Tools → FBR reference
data → HS code → valid UoM** in the app to confirm before populating in bulk.

## 4. Marketing Documents → Rows (table `INV1`) — optional

Only needed if you sell items subject to further/extra tax, FED in ST mode,
withholding, or SRO-based rates.

| Field name | Description | Type | Length |
|---|---|---|---|
| `FBR_FurtherTax` | Further tax amount | Amount | — |
| `FBR_ExtraTax` | Extra tax amount | Amount | — |
| `FBR_FED` | FED payable | Amount | — |
| `FBR_STWithheld` | ST withheld at source | Amount | — |
| `FBR_RetailPrice` | Fixed notified / retail price | Amount | — |
| `FBR_SROSchedule` | SRO schedule no. | Alphanumeric | 30 |
| `FBR_SROItem` | SRO item serial no. | Alphanumeric | 30 |
| `FBR_HSCode` | HS code override | Alphanumeric | 15 |
| `FBR_SaleType` | Sale type override | Alphanumeric | 60 |

If you skip these, the app sends `0` / `""` for those fields, which is correct
for a plain standard-rated sale.

---

## Verifying the fields are visible to Service Layer

Once created, confirm they appear in the OData metadata:

```
GET https://<host>:50000/b1s/v1/$metadata
```

Search the response for `U_FBR_IRN`. The app's **Tools → SAP diagnostics →
Download Service Layer $metadata** does this for you and saves the file to
`data/sap-metadata.xml`.

## Printing the FBR logo and QR code

Spec section 6 requires every registered invoice to carry the FBR Digital
Invoicing logo and a QR code:

- QR version 2.0 (25×25 modules)
- Printed size 1.0 × 1.0 inch

Add these to the Crystal Report / PLD invoice layout, encoding `U_FBR_IRN` in the
QR code. That is a layout change inside SAP and is outside the scope of this app.
