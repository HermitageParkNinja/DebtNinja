# ASHVEIL - Deployment Guide

## Get it live in 30 minutes

### What you need before starting
- A GitHub account (free)
- A Stripe account (you have this)
- A credit card for Supabase (free tier is fine to start)
- An Anthropic API key (console.anthropic.com, pay-as-you-go)

---

## Step 1: Supabase (Database + Auth + File Storage) - 10 mins

1. Go to **supabase.com** and create a new project
2. Pick region: **London (eu-west-2)**
3. Set a strong database password - save it somewhere
4. Wait for the project to spin up (2 mins)
5. Go to **SQL Editor** in the left sidebar
6. Paste the entire contents of `schema.sql` and click **Run**
7. Go to **Storage** in the left sidebar, click **New Bucket**, name it `documents`, set it to **private**
8. Go to **Project Settings > API** and copy:
   - Project URL (goes in `NEXT_PUBLIC_SUPABASE_URL`)
   - `anon` public key (goes in `NEXT_PUBLIC_SUPABASE_ANON_KEY`)
   - `service_role` secret key (goes in `SUPABASE_SERVICE_ROLE_KEY`)

### Create your admin user
9. Go to **Authentication > Users** and click **Add User**
10. Enter your email and a password
11. Copy the user UUID
12. Go to **SQL Editor** and run:
```sql
INSERT INTO users (id, email, name, role)
VALUES ('YOUR-USER-UUID-HERE', 'jamie@zenith.legal', 'Jamie Anderson', 'admin');
```

---

## Step 2: API Keys - 5 mins

### Anthropic (Claude API)
1. Go to **console.anthropic.com**
2. Create an API key
3. Add credit (start with $10, that's ~3 million tokens on Sonnet)
4. Copy the key (goes in `ANTHROPIC_API_KEY`)

### Stripe
1. Go to **dashboard.stripe.com > Developers > API Keys**
2. Copy your **Secret key** (goes in `STRIPE_SECRET_KEY`)
3. Copy your **Publishable key** (goes in `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`)
4. For webhooks (set up after deploy):
   - Go to **Developers > Webhooks**
   - Add endpoint: `https://your-app-url.railway.app/api/webhooks/stripe`
   - Select event: `checkout.session.completed`
   - Copy the signing secret (goes in `STRIPE_WEBHOOK_SECRET`)

---

## Step 3: Deploy to Railway - 10 mins

1. Push this folder to a **GitHub repo**:
```bash
cd ashveil
git init
git add .
git commit -m "Ashveil v1"
git remote add origin git@github.com:YOUR-USERNAME/ashveil.git
git push -u origin main
```

2. Go to **railway.app** and sign in with GitHub
3. Click **New Project > Deploy from GitHub Repo**
4. Select your ashveil repo
5. Railway auto-detects Next.js
6. Go to **Variables** tab and add ALL the env vars from `.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ANTHROPIC_API_KEY`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
   - `NEXT_PUBLIC_APP_URL` = your Railway URL (e.g. `https://ashveil-production.up.railway.app`)

7. Railway will auto-deploy. Takes about 2 mins.
8. Click **Generate Domain** to get your public URL

---

## Step 4: Stripe Webhook - 2 mins

1. Copy your Railway URL
2. Go back to **Stripe > Developers > Webhooks**
3. Add endpoint: `https://YOUR-RAILWAY-URL/api/webhooks/stripe`
4. Select event: `checkout.session.completed`
5. Copy the webhook signing secret and add it to Railway env vars

---

## Step 5: Test It

1. Open your Railway URL in the browser
2. You should see the Ashveil dashboard
3. Click **Add Debtor**
4. Select CVL or Commercial
5. Fill in details, upload docs
6. The AI analysis will call Claude and return real results
7. Generate a Stripe payment link - should produce a real link
8. Send yourself the link, make a test payment with Stripe test card `4242 4242 4242 4242`
9. Check the webhook fires and the debtor updates

---

## What works today (Phase 1)
- Full dashboard UI
- Add debtors (CVL and Commercial)
- Client segregation (admin only)
- Claude AI intelligence parsing on uploaded docs
- Stripe payment link generation
- Stripe webhook auto-updates on payment
- Document upload to Supabase storage
- All data persisted in Postgres

## What needs building next (Phase 2 - next sessions)
- Real auth login screen (Supabase Auth)
- SendGrid email sending
- Twilio SMS/WhatsApp
- Vapi AI voice calls
- Sequence scheduler (cron job that checks daily what needs to go out)
- Email open tracking webhooks
- SMS reply webhooks
- Document text extraction (PDF parsing for Claude)

## What comes later (Phase 3)
- Auto-collection portal (public web page, 5% fee)
- Multi-campaign with separate Stripe accounts
- Reporting and analytics
- Client portal (viewer access for IP firms)

---

## Running locally

```bash
npm install
cp .env.example .env.local
# Fill in your keys in .env.local
npm run dev
```

Open http://localhost:3000

---

## File Structure

```
ashveil/
  app/
    api/
      debtors/route.js     # CRUD for debtors
      documents/route.js    # File upload
      intelligence/route.js # Claude AI analysis
      stripe/route.js       # Payment link generation
      webhooks/stripe/      # Stripe payment webhooks
    layout.js               # Root layout
    page.js                 # Main entry point
    globals.css             # Global styles
  components/
    Ashveil.jsx             # Full UI (currently with mock data)
  lib/
    api.js                  # Frontend API client
    supabase.js             # Supabase client helpers
  schema.sql                # Database schema (run in Supabase)
  .env.example              # Environment variables template
  package.json
  next.config.js
```

---

## Costs (monthly estimate)

| Service | Cost |
|---------|------|
| Railway hosting | ~£5-10 |
| Supabase (free tier) | £0 |
| Claude API | ~£30-50 |
| Stripe | 1.4% + 20p per transaction |
| **Total** | **~£40-60/month** |

First settlement covers a year.
