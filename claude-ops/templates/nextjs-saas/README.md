# Next.js SaaS Template

Production-ready SaaS starter with Next.js 14 App Router, Auth.js v5, Stripe billing, Prisma ORM, and Tailwind CSS.

## Features

- **Next.js 14 App Router** — server components, layouts, route groups
- **Auth.js v5 (next-auth@beta)** — GitHub and Google OAuth, PrismaAdapter, server-side sessions
- **Stripe billing** — subscription webhook handler with signature verification
- **Prisma ORM** — PostgreSQL with User, Account, Session, Subscription, VerificationToken models
- **Tailwind CSS v3** — utility-first styling, responsive dashboard layout
- **Landing page** — hero section with CTA buttons
- **Dashboard layout** — sidebar navigation, metric cards

## Prerequisites

- Node 20+
- PostgreSQL (local or hosted)
- Stripe account (for billing features)
- GitHub OAuth App and/or Google OAuth credentials

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file and fill in all values
cp .env.example .env

# 3. Push Prisma schema to database
npm run db:push

# 4. Start development server
npm run dev
```

The app will be available at `http://localhost:3000`.

## Environment Variables

| Variable                 | Description                                       |
| ------------------------ | ------------------------------------------------- |
| `DATABASE_URL`           | PostgreSQL connection string                      |
| `NEXTAUTH_URL`           | Full URL of your app (e.g. `http://localhost:3000`) |
| `NEXTAUTH_SECRET`        | Random 32+ char secret for session signing        |
| `GITHUB_CLIENT_ID`       | GitHub OAuth App client ID                        |
| `GITHUB_CLIENT_SECRET`   | GitHub OAuth App client secret                    |
| `GOOGLE_CLIENT_ID`       | Google OAuth client ID                            |
| `GOOGLE_CLIENT_SECRET`   | Google OAuth client secret                        |
| `STRIPE_SECRET_KEY`      | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET`  | Stripe webhook signing secret (`whsec_...`)       |

## Auth Provider Setup

### GitHub OAuth
1. Go to GitHub → Settings → Developer Settings → OAuth Apps → New OAuth App
2. Set **Authorization callback URL** to `http://localhost:3000/api/auth/callback/github`
3. Copy Client ID and Client Secret to `.env`

### Google OAuth
1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Add `http://localhost:3000/api/auth/callback/google` as an authorized redirect URI
4. Copy Client ID and Client Secret to `.env`

## Stripe Webhook Setup

1. Install Stripe CLI: `brew install stripe/stripe-cli/stripe`
2. Forward events to your local server:
   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```
3. Copy the webhook signing secret output to `STRIPE_WEBHOOK_SECRET` in `.env`
4. In production, create a webhook endpoint in the Stripe Dashboard pointing to `https://yourdomain.com/api/webhooks/stripe`

## Deployment

### Vercel (recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

1. Push your repo to GitHub
2. Import the project in Vercel
3. Add all environment variables in the Vercel dashboard
4. Set `NEXTAUTH_URL` to your production domain
5. Deploy

### Other platforms

Build the app and run it:

```bash
npm run build
npm start
```

Ensure `DATABASE_URL` points to a production PostgreSQL instance and run `npm run db:push` (or `prisma migrate deploy` for production migrations) before starting.
