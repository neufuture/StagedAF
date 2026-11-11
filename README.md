# StagedAF — virtual staging for AppFolio

A Chrome / Edge extension that virtually stages listing photos inside AppFolio
property and unit pages, using an AI image model with your own API key.

## What it does

**New uploads.** Turn on **Stage new uploads** in the StagedAF panel
(bottom-right of the page). The next time you pick or drop photos into
AppFolio's uploader, the upload is paused and you tick the photos you want
staged (with a room type per photo, plus a style and optional instructions).
Those are staged, you see before/after, and then the final set — staged and
untouched photos, in the original order — is handed to AppFolio's uploader.

**Existing photos.** Every photo on the page gets a **✦ Stage** button. Click
it, leave the instructions blank for default staging or type what you want,
and when the result is ready choose **Replace original** (uploads the staged
photo, then deletes the old one) or **Add, keep original**.

The original is only deleted after the staged photo is confirmed on the page,
and by default a copy of the original is saved to `Downloads/StagedAF` first.

## Install

1. Open `chrome://extensions` (or `edge://extensions`) and switch on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. The settings page opens. Paste an OpenAI API key and click **Test key**.
4. Open a property or unit page in AppFolio.

## Image model

The default is OpenAI's `gpt-image-2` through the image *edits* API — the same
family of model behind image editing in ChatGPT and Copilot. Model, quality
and API base URL are all in settings, so a different OpenAI image model, or an
OpenAI-compatible endpoint, can be swapped in without code changes. Parameters
a model rejects are dropped automatically.

Photos go directly from your browser to the image service. Nothing passes
through any other server, and the API key is stored only in this browser.

Each photo is billed by the provider to your key; `high` quality costs the
most and takes around a minute.

## Settings worth knowing

| Setting | Default | |
|---|---|---|
| Review before upload | on | Before/after check before staged uploads are sent |
| Replace automatically | off | Skip the review for existing photos |
| Save the original first | on | Backup to `Downloads/StagedAF` before a replace |
| Disclosure label | off | Burns "Virtually staged" into a corner of the photo |
| Default staging prompt | — | Editable; `{room}` and `{style}` are filled per photo |

Many listing services and fair-advertising rules expect virtually staged
photos to be disclosed. The label option is there for that.

## How it works with AppFolio (and its limits)

AppFolio has no public API for photos, so StagedAF works the page the way you
would: it gives files to AppFolio's own **Upload Photo** input and clicks
AppFolio's own delete link (and its "Delete" confirmation).

The **Photos** card on unit pages is recognised directly from its markup
(`.js-attached-photos`): the photo list, the upload input, the delete link,
and the Default / Make Default controls. The separate **Attachments**
uploader on the same page is never touched. If the photo you replace was the
unit's default photo, the staged one is made the default before the original
is deleted.

This is tested end-to-end against a mock page that mirrors that markup
(`test/`), **not yet against a live AppFolio account** — in particular,
AppFolio's upload script and confirm dialog are simulated. On pages without
the Photos card, detection falls back to guessing. If something isn't
detected:

- Click **Copy page diagnostics** in the StagedAF panel. It copies a
  description of the page structure (tag and class names only — no names,
  addresses or photos) that shows what was and wasn't found.
- Settings → *AppFolio page detection* lets you set CSS selectors for the
  photos, the upload input and the delete button, and the URL pattern for
  pages to run on.

Known limits:

- A replaced photo is added through the uploader, so it lands wherever
  AppFolio puts new photos (usually last), not in the original's position.
- The staging queue lives in the open tab. Leaving the page drops queued work
  (you'll get a "leave site?" warning).
- HEIC and RAW files aren't staged; they upload untouched.
- If photos are served from a host other than `*.appfolio.com` and can't be
  read, grant that host under Settings → *Image host access*.

## Layout

```
manifest.json
src/background.js         service worker: settings, downloads, offscreen page
src/offscreen.js          runs the (slow) image API calls
src/shared/               defaults, prompt building, image helpers
src/content/appfolio.js   everything that touches AppFolio's page
src/content/uploads.js    flow 1: new uploads
src/content/existing.js   flow 2: Stage buttons on existing photos
src/content/review.js     before/after review, replace routine
src/content/dock.js       the corner panel
src/options.*             settings page
test/e2e.js               end-to-end test with a mock AppFolio page + mock API
```

Run the test with `node test/e2e.js` (needs Playwright with Chromium).
