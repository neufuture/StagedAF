# Setting up the UnitStager server

The extension talks to one small server that handles sign-in, credits,
staging and payments. This guide gets it running. Nothing here needs a
command line.

Dashboard labels change over time; if a menu isn't where this says, look for
the nearest match.

You will collect **six secret values** along the way. Keep them in a private
note until step 5:

| Name | Comes from |
|---|---|
| `SUPABASE_URL` | Supabase |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase |
| `SUPABASE_SECRET_KEY` | Supabase |
| `OPENAI_API_KEY` | OpenAI |
| `STRIPE_SECRET_KEY` | Stripe |
| `STRIPE_WEBHOOK_SECRET` | Stripe |

Never paste these into chat, email or the code.

## 1. Domain

Register `unitstager.com`. Buying it through Cloudflare (Domain Registration)
saves a step later; any registrar works.

## 2. Supabase (accounts and credits)

1. Create a project at supabase.com. Any region near Oregon is fine.
2. **Create the tables.** Open **SQL Editor**, paste the whole of
   [`server/supabase/schema.sql`](../server/supabase/schema.sql), and click **Run**.
3. **Make sign-in emails show a code.** Under **Authentication → Emails**
   (templates), edit both **Magic Link** and **Confirm signup** so the body
   contains the code, for example:

   ```html
   <h2>Your UnitStager sign-in code</h2>
   <p style="font-size:28px;letter-spacing:4px"><b>{{ .Token }}</b></p>
   <p>Enter this code in the UnitStager settings page. It expires shortly.</p>
   ```

   `{{ .Token }}` is the part that matters. Without it the email contains a
   link instead of a code, and sign-in from the extension won't work.
4. **Copy the keys.** Under **Project Settings → API Keys** (and **Data API**
   for the URL): the project URL is `SUPABASE_URL`, the publishable key is
   `SUPABASE_PUBLISHABLE_KEY`, and the secret key is `SUPABASE_SECRET_KEY`.
   (Older projects call these `anon` and `service_role`; those work too.)

**Before inviting customers:** Supabase's built-in email sender only allows a
handful of emails per hour and is meant for testing. Under **Authentication →
SMTP settings**, connect a real email service (Resend and Postmark are common)
so sign-in codes arrive reliably and come from your domain.

## 3. OpenAI (the image model)

1. At platform.openai.com, add a payment method. All customers' staging is
   billed to this account.
2. Create an API key: this is `OPENAI_API_KEY`.
3. If staging later fails with a message about verification, complete
   organization verification in the OpenAI dashboard; it is required for some
   image models.

## 4. Stripe (payments)

Do all of this in **test mode** first.

1. Create an account at stripe.com.
2. **Developers → API keys:** the secret key (`sk_test_…`) is `STRIPE_SECRET_KEY`.
3. **Developers → Webhooks → Add endpoint:**
   - URL: `https://unitstager.com/api/stripe/webhook`
     (until the domain is connected, use the `…workers.dev` address from step 5)
   - Events: `checkout.session.completed` and
     `checkout.session.async_payment_succeeded`
   - After saving, reveal the **signing secret** (`whsec_…`): this is
     `STRIPE_WEBHOOK_SECRET`.

There are no products to create in Stripe. Credit packs and prices are defined
on the server (see "Changing prices" below).

## 5. Cloudflare (hosting)

1. In the Cloudflare dashboard: **Workers & Pages → Create → Import a
   repository**, and connect GitHub.
2. Choose the `neufuture/StagedAF` repository and the branch that has the
   `server` folder.
3. Set the **root directory** (sometimes labelled "Path") to `server`. Leave
   the build command empty and the deploy command as `npx wrangler deploy`.
   If the build fails with "Could not detect a directory containing static
   files", the root directory wasn't set: fix it under **Settings → Build**
   and retry.
4. Deploy. Opening the Worker's address should show the UnitStager website.
5. **Add the six secrets.** In the Worker: **Settings → Variables and
   Secrets → Add** (the runtime one, not the one under Build). Add each of
   the six names from the table above, choosing type **Secret** for all.
6. **Connect the domain.** In the Worker's **Domains** tab, under **Custom
   Domains and Routes**, click **Add Domain** and enter `unitstager.com`.

From then on, every change pushed to that branch redeploys automatically.

## 5b. Photo storage and background staging

Staging runs in the background and staged photos are kept for 30 days. This
needs two things in Cloudflare. **Create both before the server update that
adds them is deployed** — if they are missing, Cloudflare's build fails and
the previous version stays live until they exist and you retry the deploy.

1. **R2 bucket:** in the Cloudflare dashboard, **R2 Object Storage → Create
   bucket**, named exactly `unitstager-photos`. (R2 may ask you to add a
   payment method to switch it on; small use like this is within its free
   allowance.)
2. **Queue:** **Workers & Pages → Queues → Create queue**, named exactly
   `unitstager-staging`.
3. Optional safety net: in the bucket's **Settings → Object lifecycle rules**,
   add a rule to delete objects after 30 days. The server already deletes
   expired photos hourly; this catches anything it misses.

Then re-run `server/supabase/schema.sql` (it adds the `stagings` table) and
retry the deploy under the Worker's **Deployments** tab.

## 6. Try it end to end

1. In the extension's settings, under **Advanced**, the **UnitStager server**
   should be `https://unitstager.com` (or your `workers.dev` address while
   testing).
2. Under **Account**, enter your email, get the code, sign in. You should see
   10 free credits.
3. Stage a photo in AppFolio. The balance should drop by one.
4. Click a **Buy** button. Pay with Stripe's test card `4242 4242 4242 4242`,
   any future date, any CVC. Back on the settings tab, the credits should
   appear within a few seconds.

If something fails, the Worker's **Logs** tab in Cloudflare shows why.

## 7. Before real customers

- [ ] Switch Stripe to **live mode**: replace `STRIPE_SECRET_KEY` with the live
      key, create the webhook again in live mode, and replace
      `STRIPE_WEBHOOK_SECRET`.
- [ ] Connect a real email service in Supabase (step 2).
- [ ] Have `server/public/privacy.html` and `server/public/terms.html` reviewed
      by a lawyer. In particular, check the refund policy (section 3) and the
      choice of Oregon law (section 12) in the terms.
- [ ] Publish the extension (see [`STORE_LISTING.md`](STORE_LISTING.md)), then put
      the Chrome and Edge store links in `STORE_URLS` at the top of `server/public/site.js`.

## Day-to-day

**Changing prices or free credits.** These live in `server/wrangler.jsonc`
under `vars`. Free sign-up credits are `FREE_CREDITS`. The packs default to
25 for $19, 50 for $34 and 100 for $59; to change them, add a `PACKS` entry
(amounts are in cents). The "Save n%" labels are worked out automatically.

```jsonc
"PACKS": "[{\"id\":\"pack25\",\"name\":\"25 staged photos\",\"credits\":25,\"amount\":1900},{\"id\":\"pack50\",\"name\":\"50 staged photos\",\"credits\":50,\"amount\":3400},{\"id\":\"pack100\",\"name\":\"100 staged photos\",\"credits\":100,\"amount\":5900}]"
```

**After a server update that changes the database.** (Most recently: cost
tracking and alerts.) Run
`server/supabase/schema.sql` again in the Supabase SQL Editor. It is written
to be run repeatedly and never removes data.

**Payment methods (Stripe customer portal).** The website's Account page has
a **Manage payment methods** button that opens Stripe's own page, where
customers add, remove or change saved cards and see past payments. Stripe
only allows this once you have switched it on: in Stripe go to **Settings →
Billing → Customer portal**, turn on **Customers can update payment methods**
(and, if you like, **view invoice/payment history**), and click **Save**. Do it
in test mode and again in live mode. Until then the button shows a message
asking customers to email you.

**Receipts.** Customers see their purchases under **Purchase history** in
the extension's settings, each with a link to its Stripe receipt. To also
email a receipt after every payment, turn on **Successful payments** under
Stripe's **Settings → Customer emails**. The business name and details shown
on receipts come from Stripe's **Settings → Business → Public details**.

**Auto top-up.** A customer turns it on by ticking the box when buying a
pack; Stripe saves their card. When their balance falls to 3 credits the
server charges that card for the same pack and adds the credits. A declined
card switches it off. To see who has it on:

```sql
select email, credits, auto_pack from accounts where auto_pack is not null;
```

**Security headers.** `server/public/_headers` sets the website's
Content-Security-Policy and other security headers. If you add a third-party
script (for example the Featurebase chat widget), its domains must be added to
the policy there, or the browser will block it.

**Limits, alerts and Turnstile.** All of these are set with variables in
Cloudflare: Worker → **Settings → Variables and Secrets** → **Add**. Plain
settings use type *Text*; keys use type *Secret*. They are kept when the
server redeploys.

| Variable | Type | Default | What it does |
|---|---|---|---|
| `TURNSTILE_SITE_KEY` | Text | — | Turns on the sign-up security check (with the secret below) |
| `TURNSTILE_SECRET_KEY` | Secret | — | |
| `TURNSTILE_REQUIRED` | Text | off | `true` refuses sign-in without the check. Leave off until everyone has an extension version with it (1.2.0+) |
| `RESEND_API_KEY` | Secret | — | Sends alert and daily-summary emails (a Resend key with sending access) |
| `ALERT_EMAIL` | Text | — | Where alerts go, e.g. `hello@unitstager.com` (comma-separate several) |
| `BUSINESS_ADDRESS` | Text | — | Postal address (or PO box) printed in follow-up emails; required by US law for marketing email, and none are sent without it |
| `NUDGES` | Text | on | `off` stops all follow-up emails |
| `ALERT_DAILY_COST_USD` | Text | 25 | Email when estimated image spend in a day passes this |
| `DAILY_STAGING_CAP` | Text | off | Stop new stagings after this many in a day (safety valve) |
| `FREE_CREDITS` | (in wrangler.jsonc) | 10 | Free credits per new account |
| `LIMIT_FREE_ACCOUNTS_PER_IP_MONTH` | Text | 10 | New accounts given free credits per network per 30 days |
| `LIMIT_CODES_PER_IP_HOUR` | Text | 30 | Sign-in code emails per network per hour (check passed) |
| `LIMIT_CODES_PER_IP_HOUR_UNVERIFIED` | Text | 10 | …without the check |
| `LIMIT_CODES_PER_EMAIL_HOUR` | Text | 8 | Sign-in code emails per address per hour |
| `LIMIT_SIGNINS_PER_IP_HOUR` | Text | 60 | Sign-in attempts per network per hour |
| `LIMIT_PROMO_PER_IP_HOUR` | Text | 30 | Promo-code attempts per network per hour |
| `PRICE_IMAGE_OUTPUT_PER_M` etc. | Text | 30 / 8 / 5 | Token prices used for cost estimates (see docs/COSTS.md) |

**Setting up Turnstile:** in Cloudflare go to **Turnstile → Add widget**,
name it UnitStager, add hostname `unitstager.com`, choose **Managed** mode,
and create it. Copy the **site key** into `TURNSTILE_SITE_KEY` and the
**secret key** into `TURNSTILE_SECRET_KEY`.

**Follow-up emails** go out with the daily run (15:07 UTC) through Resend,
once per kind per customer: a reminder 1 day and 4 days after sign-up if no
photo has been staged, a "get more credits" note a day after running out (if
they've never bought), and a "vacancy coming up?" note 30 days after a buyer's
last staging. They come from hello@unitstager.com, replies go to
hello@unitstager.com, and each has a one-click unsubscribe. The daily summary
counts how many went out. Needs `RESEND_API_KEY` and `BUSINESS_ADDRESS`.

**Alerts** arrive at most once an hour per kind (once a day for spend and the
daily cap): a limit was reached, stagings are failing, an auto top-up was
declined, spend passed the threshold. A **daily summary** is emailed at 15:07
UTC (about 7am Pacific). Without `RESEND_API_KEY` and `ALERT_EMAIL`, these only
appear in the Worker's logs.

Costs and margins: see [`COSTS.md`](COSTS.md).

**Promo codes (free credits for testers).** Create codes in Supabase:
**Table Editor → promo_codes → Insert row**.

| Column | What to enter |
|---|---|
| `code` | The code, e.g. `BETA25`. Letters, numbers and dashes; it is stored in capitals, so customers can type it either way. |
| `credits` | How many credits it gives. |
| `max_uses` | How many accounts can use it in total. Leave empty for unlimited. |
| `expires_at` | When it stops working. Leave empty for never. |
| `active` | Untick to switch a code off. |
| `note` | Who it's for, for your own reference. |

Each account can use a given code once. Customers enter codes on the website's
Account page or in the extension's settings, or you can send a link that signs
them up and applies the code in one go:
`https://unitstager.com/app.html?code=BETA25`

Who has used a code: `select * from promo_redemptions where code = 'BETA25';`

**Giving someone free credits** (Supabase → SQL Editor):

```sql
select add_credits((select user_id from accounts where email = 'person@example.com'), 50, 'manual', null);
```

They must have signed in once first.

**Seeing who has signed up:**

```sql
select email, credits, created_at from accounts order by created_at desc;
```

**Seeing what an account did:**

```sql
select l.created_at, l.delta, l.reason
from credit_ledger l join accounts a using (user_id)
where a.email = 'person@example.com' order by l.created_at desc;
```
