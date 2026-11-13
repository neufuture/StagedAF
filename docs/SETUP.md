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
3. Set the **root directory** to `server`. Leave the deploy command as
   `npx wrangler deploy`.
4. Deploy. You get an address like `unitstager.<your-name>.workers.dev`.
   Opening it should show the UnitStager website.
5. **Add the six secrets.** In the Worker: **Settings → Variables and
   Secrets → Add**. Add each of the six names from the table above, choosing
   type **Secret** for all of them.
6. **Connect the domain.** **Settings → Domains & Routes → Add → Custom
   domain →** `unitstager.com`.

From then on, every change pushed to that branch redeploys automatically.

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
- [ ] Fill in the bracketed placeholders in `server/public/privacy.html` and
      have the page reviewed.
- [ ] Set real prices (below).
- [ ] Publish the extension to the Chrome Web Store, then put its link in
      `INSTALL_URL` at the top of `server/public/site.js`.

## Day-to-day

**Changing prices or free credits.** These live in `server/wrangler.jsonc`
under `vars`. Free sign-up credits are `FREE_CREDITS`. To change the packs,
add a `PACKS` entry (amounts are in cents):

```jsonc
"PACKS": "[{\"id\":\"pack25\",\"name\":\"25 staged photos\",\"credits\":25,\"amount\":1900},{\"id\":\"pack100\",\"name\":\"100 staged photos\",\"credits\":100,\"amount\":5900}]"
```

The prices currently in the code are placeholders.

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
