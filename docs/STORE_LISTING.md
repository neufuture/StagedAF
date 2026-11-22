# Publishing UnitStager to the Chrome Web Store and Edge Add-ons

Everything below is bundled in one download, `dist/unitstager-store-kit-<version>.zip`
(rebuild with `bash scripts/store-kit.sh`). The upload package itself is
`dist/unitstager-extension-<version>.zip`. The same file
goes to both stores. Rebuild it after any change with `bash scripts/package.sh`
(bump `"version"` in `manifest.json` first; stores reject a repeated version).

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

UnitStager adds virtual staging to the AppFolio pages you already use.

On a unit's Photos section, every photo gets a Stage button. Click it, pick a
room type and style or type what you want, and in about a minute you get a
furnished version to compare side by side with the original. One more click
uploads the staged photo to the unit and removes the original; a copy of the
original is saved to your computer first.

Uploading a fresh set of photos? Switch on "Stage new uploads" and choose
which empty rooms to furnish before anything is sent to AppFolio.

• Furniture is added; walls, floors, windows and fixtures are left as they are
• Before/after review on every photo, with one-click regenerate
• Optional "Virtually staged" disclosure label
• Works on property and unit pages

Sign in with your email to get free staged photos. After that it is pay per
photo, with credit packs that don't expire and optional auto top-up.

UnitStager is an independent product and is not affiliated with or endorsed
by AppFolio, Inc.

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
- Store icon: `icons/icon128.png`.
- Logo files for anywhere else (social profiles, email signature) are in
  `brand/`, as a rounded square and as a circle.

The screenshots show part of a street address in the photo file names
("4919 NE 2…"). Swap them for ones from another unit if that matters.
