# Publishing UnitStager to the Chrome Web Store and Edge Add-ons

Everything below is bundled in one download, `dist/unitstager-store-kit-<version>.zip`
(rebuild with `bash scripts/store-kit.sh`). The upload package itself is
`dist/unitstager-extension-<version>.zip`. The same file
goes to both stores. Rebuild it after any change with `bash scripts/package.sh`
(bump `"version"` in `manifest.json` first; stores reject a repeated version).

## Publisher name

Use **Neufuture, LLC** as the publisher / developer name in both stores, exactly
as it appears on the company's registration documents.

## Where to upload

- **Chrome Web Store:** chrome.google.com/webstore/devconsole. Needs a
  developer account (a small one-time registration fee). Click **New item**
  and upload the zip.
- **Microsoft Edge Add-ons:** partner.microsoft.com → Edge → **Create new
  extension**, and upload the same zip.

Both review the submission before it goes live; allow a few days. Either
store lets you publish as **unlisted** (only people with the link can find
it), which suits a first group of testers.

Once each listing is live, paste its link into `STORE_URLS` at the top of
`server/public/site.js` so the website's "Add to Chrome" and "Add to Edge"
buttons work.

## Listing text

**Name**

UnitStager – Virtual Staging for AppFolio

**Short description** (132 characters max)

Virtually stage unit photos without leaving AppFolio. Furnish empty rooms in about a minute and replace the original in one click.

**Category:** Workflow & Planning (Chrome) / Productivity (Edge)

**Detailed description**

Virtually stage unit photos without leaving AppFolio.

UnitStager adds AI virtual staging to the AppFolio Property Manager pages you
already use. Empty rooms photograph poorly; UnitStager furnishes them in about
a minute, right where your listing photos live.

STAGE PHOTOS ALREADY IN APPFOLIO
Every photo in a unit's Photos section gets a Stage button. Pick a room type
and one of eight styles (Modern, Scandinavian, Mid-century modern,
Transitional, Modern farmhouse, Coastal, Industrial, Traditional), or type
your own instructions, such as "sectional facing the window, warm neutrals".
Compare the result side by side with the original, regenerate if it isn't
right, then replace the original in one click. The staged photo is uploaded to
the unit, the original is removed, and the unit's default photo stays the
default. A copy of the original is saved to your computer first.

STAGE NEW UPLOADS
Switch on "Stage new uploads" and, whenever you add photos to a unit, choose
which empty rooms to furnish before anything is sent to AppFolio. The rest
upload as they are.

BUILT FOR LISTINGS
• Furniture and decor are added; walls, floors, windows and fixtures are left
  as they are, so the photo still shows the real unit
• Optional "Virtually staged" label on each photo for listing-site and
  advertising disclosure rules
• Stage several photos at once and keep working while they finish
• Staging carries on if you close the tab; staged photos are kept for 30 days
  under Recent stagings at unitstager.com

ACCOUNT AND PRICING
Sign in with your email (a one-time code, no password) and get free staged
photos to start. After that it's pay per photo: one credit stages one photo,
credit packs don't expire, and a failed staging is refunded automatically.
Optional auto top-up, promo codes, and purchase history with receipts are in
the extension's settings and on unitstager.com.

PRIVACY
UnitStager only acts on AppFolio pages, and only on photos you choose to
stage. It doesn't read tenant, owner or financial data from AppFolio and never
stores your AppFolio login. Privacy policy: https://unitstager.com/privacy.html

UnitStager is created by Neufuture, LLC. It is an independent product and is
not affiliated with or endorsed by AppFolio, Inc.

**Privacy policy URL:** https://unitstager.com/privacy.html

**Support email:** hello@unitstager.com

## Review questions (Chrome's "Privacy practices" tab)

**Single purpose**

Virtually stage listing photos on AppFolio property and unit pages.

**Permission justifications**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings and sign-in session on their device. |
| `offscreen` | Staging a photo takes one to two minutes, longer than a background service worker stays alive. An offscreen document resizes the photo and waits for the result. |
| `downloads` | Saves a copy of the original photo to the user's Downloads folder before it is replaced, and lets the user download a staged photo. |
| Host permission `https://*.appfolio.com/*` | The extension runs only on AppFolio. It adds Stage buttons to photos on property and unit pages, reads the photo the user chooses to stage, and uploads the staged photo through AppFolio's own uploader. |

**Remote code:** No. All code is in the package.

**Data usage** — tick these four and nothing else:

- *Personally identifiable information*: the user's email address, for sign-in.
- *Financial and payment information*: the extension starts credit purchases
  and shows the user's purchase history (amounts and dates). Card numbers are
  entered on Stripe's page and never pass through the extension.
- *Authentication information*: the one-time sign-in code the user types, and
  the sign-in session the extension keeps so the user stays signed in.
- *Website content*: the photos the user chooses to stage, and any instructions they type. Sent to the UnitStager server only when the user clicks Stage.

Certify that data is not sold, not used for purposes unrelated to the
extension's single purpose, and not used for creditworthiness or lending.

## Images

Ready to upload, in the `store/` folder:

- `screenshot-1-stage-button.png`, `screenshot-2-before-after.png`,
  `screenshot-3-in-appfolio.png` — 1280×800, in that order.
- `promo-tile-440x280.png` — Chrome's optional small promo tile.
- `marquee-1400x560.png` — Chrome's optional marquee promo tile.
- Store icon: `icons/icon128.png` (Chrome); `logo/unitstager-icon-300.png` (Edge, 300×300).
- Logo files for anywhere else (social profiles, email signature) are in
  `brand/`, as a rounded square and as a circle.

The screenshots show part of a street address in the photo file names
("4919 NE 2…"). Swap them for ones from another unit if that matters.
