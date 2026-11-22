# UnitStager cost analysis

What one staged photo costs, what each credit pack earns, and how to check the
real numbers as you go. Prices of outside services change; the figures below
were gathered in November 2026 and should be checked against each provider's
pricing page.

## 1. Cost of one staged photo

The image service (OpenAI GPT Image, high quality, about 1536x1024) charges by
tokens:

| Part | Typical tokens | Rate (per million) | Cost |
|---|---|---|---|
| Staged image out | ~5,400 | $30 | ~$0.165 |
| Your photo in | ~1,000–1,500 | $8 | ~$0.01 |
| Prompt and instructions in | ~300 | $5 | ~$0.002 |
| **Total** | | | **~$0.18** |

The $0.165 output figure is the commonly published price for a high-quality
image at this size; the input amounts are estimates. **The real figure is now
recorded for every staging** (from the token counts OpenAI reports) and shown
in the daily summary email as "avg … per photo". Use that number once you have
a few days of real use.

Failed stagings are refunded to the customer and usually aren't billed by
OpenAI (a declined photo isn't). A retried hiccup can occasionally cost twice.

## 2. What each credit earns

Stripe's standard US card fee is 2.9% + $0.30 per payment.

| Pack | Price | Stripe fee | You receive | Per credit | Image cost | **Margin per photo** |
|---|---|---|---|---|---|---|
| 25 credits | $19 | $0.85 | $18.15 | $0.73 | $0.18 | **$0.55 (75%)** |
| 50 credits | $34 | $1.29 | $32.71 | $0.65 | $0.18 | **$0.47 (72%)** |
| 100 credits | $59 | $2.01 | $56.99 | $0.57 | $0.18 | **$0.39 (68%)** |

If the real cost per photo turns out to be $0.25, margins become about $0.48,
$0.40 and $0.32. Credits that are bought but never used cost nothing.

**Free and promo credits** are real costs: 10 free credits cost about $1.80
per sign-up that uses them all. With the current limits (10 free-credit
accounts per network per month, Turnstile required for free credits) the
worst case is bounded; watch "Free credits" in the daily summary.

## 3. Fixed monthly costs

| Service | Free tier | Likely paid tier | Notes |
|---|---|---|---|
| Cloudflare Workers | $0 | $5/month (Workers Paid) | Needed only if background stagings hit free-plan limits |
| Cloudflare R2 | $0 up to 10 GB | ~$0.015/GB-month | ~3,000 photos stored at a time is free |
| Supabase | $0 | $25/month (Pro) | Free projects can be paused when inactive and have tighter limits; move to Pro before relying on it for paying customers |
| Resend | $0 (limited emails per day/month) | ~$20/month | Every sign-in sends an email; check the free daily limit against sign-ups |
| Domain | ~$10/year | | |
| Featurebase | $0 | $29/seat/month | Optional (email in the shared inbox) |
| Chrome Web Store | $5 once | | |

Realistic fixed cost once live: **about $25–50 a month**.

**Break-even:** at roughly $0.45 margin per paid photo, $50 a month of fixed
costs is covered by about **110 paid photos a month** (about 4–5 packs).

## 4. Levers if margins need to move

- **Quality:** `OPENAI_QUALITY` (Cloudflare variable) can be set to `medium`,
  which costs much less per image. Compare results before switching.
- **Prices:** packs are set in `server/wrangler.jsonc` (`PACKS`); the "Save %"
  labels update themselves.
- **Free credits:** `FREE_CREDITS` (currently 10). 3–5 still lets people judge
  results.
- **Stripe fee share:** the fixed $0.30 hurts the smallest pack most; a $25
  minimum pack would improve it.

## 5. Checking the real numbers

The **daily summary email** shows sign-ups, free credits, stagings, average
cost per photo, image spend and revenue for the last 24 hours.

For a monthly view, in Supabase's SQL Editor:

```sql
select
  date_trunc('month', created_at) as month,
  count(*) filter (where status = 'done') as photos,
  round(sum(cost_usd), 2)                 as image_cost_usd,
  round(avg(cost_usd), 4)                 as avg_cost_per_photo
from stagings group by 1 order by 1 desc;
```

```sql
select
  date_trunc('month', created_at) as month,
  sum(amount_cents) / 100.0 as revenue_usd,
  sum(delta) filter (where reason in ('purchase', 'auto-topup')) as credits_sold,
  sum(delta) filter (where reason = 'signup')                    as free_credits,
  sum(delta) filter (where reason = 'promo')                     as promo_credits
from credit_ledger group by 1 order by 1 desc;
```

(Stagings older than 30 days are deleted with their photos, so run the first
query monthly if you want to keep a history, or ask for it to be kept.)
