# Putting the FBR number and QR code on the printed invoice

FBR spec section 6 requires **every issued invoice** to carry:

- the FBR Digital Invoicing **logo**
- a **QR code** — version 2.0 (25×25 modules), printed at **1.0 × 1.0 inch**

The app produces the QR image; placing it on the layout is a change to your
Crystal Report or PLD inside SAP, which the app cannot do for you.

---

## 1. What the app does

On each successful registration it writes a PNG named after the document
number into the folder set in **Settings → QR code**, and stores the full path
in the invoice UDF `U_FBR_QRPath`.

```
\\server\share\fbr-qr\9075.png      ← the image
OINV.U_FBR_IRN                      ← A338509DIZLMRRY981406
OINV.U_FBR_QRPath                   ← \\server\share\fbr-qr\9075.png
OINV.U_FBR_Date                     ← 2026-09-18
```

**Put the folder on a share that the machine running the report can also
reach.** Crystal resolves the path at print time, on whichever machine is
printing — a local `C:\` path works only on the machine that created it.

Use **Regenerate QR codes** for invoices registered before this existed.

---

## 2. Crystal Reports

Most B1 sites print invoices through Crystal. The QR goes in as a picture whose
location is read from the document.

1. Open your A/R Invoice report in **Crystal Reports** (SAP Business One →
   Administration → Setup → General → Report and Layout Manager, then edit).
2. Make sure `OINV` is in the report and its UDFs are available. If
   `U_FBR_QRPath` is missing, use **Database → Verify Database** to refresh.
3. **Insert → Picture** and drop any placeholder image on the layout.
4. Right-click the picture → **Format Graphic → Picture tab**.
5. Next to **Graphic Location**, click the formula button (`x-2`) and enter:

   ```
   {OINV.U_FBR_QRPath}
   ```

6. Size the frame to **1.0 × 1.0 inch** (Format Graphic → Common → Size).
   Tick **Can Grow: off** so it is not resized at render time.
7. Add the FBR number as a text field next to it: **Insert → Field Object →
   `OINV.U_FBR_IRN`**, labelled e.g. `FBR Invoice No.`
8. Place the FBR Digital Invoicing logo (from FBR's own documentation — it is
   their asset, not something this app ships) beside the QR.

### Hiding it on unregistered invoices

So drafts do not print an empty frame, suppress the section or objects when
there is no number. Right-click → **Format** → **Suppress** formula:

```
IsNull({OINV.U_FBR_IRN}) or Trim({OINV.U_FBR_IRN}) = ""
```

---

## 3. PLD (Print Layout Designer)

If you print through PLD rather than Crystal:

1. Open the invoice layout in **Print Layout Designer**.
2. Add a **Picture** field. Set its **Source Type** to *Database*, Table
   `OINV`, Column `U_FBR_QRPath`.
3. Set the field height and width to **1 inch** (PLD works in the layout's
   configured units — check Document Properties).
4. Add a **Database** field for `OINV.U_FBR_IRN` with a `Text` field label.

PLD's picture-from-path support varies by B1 version and patch level. If the
image does not render, Crystal is the reliable route.

---

## 4. Verify before going live

Print one registered invoice and check:

- [ ] The QR image appears, is square, and measures 1 × 1 inch on paper
- [ ] Scanning it with a phone returns the FBR invoice number exactly
- [ ] The FBR invoice number is printed as text as well as in the QR
- [ ] The FBR Digital Invoicing logo is present
- [ ] An unregistered invoice prints without an empty picture frame

Measure the printed square with a ruler rather than trusting the on-screen
preview — scaling set in the printer driver or in Crystal's page setup will
silently change it, and the 1 × 1 inch dimension is a stated requirement.

---

## 5. What the QR contains

The **FBR invoice number**, and nothing else.

The spec fixes the symbol format but never states the payload. Version 2 is the
constraint that settles it: it holds roughly 47 alphanumeric characters, which
fits the ~22-character invoice number but not a structured payload. The app
pins the encoder to version 2 rather than letting it grow to fit, so an
over-long value is refused instead of producing a larger symbol that still
scans but does not meet the stated format.

If FBR tells you to encode something else, **Settings → QR code** takes a
custom template where `{irn}` is substituted — but anything much longer than
the invoice number will not fit a version-2 symbol.
