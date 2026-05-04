# Next.js SaaS Template

Production-ready SaaS starter with Next.js App Router, Clerk authentication, Stripe billing, Prisma ORM, and Tailwind CSS.

## Features

- **Next.js App Router** — server components, layouts, route groups
- **Clerk** — hosted sign-in/sign-up, `clerkMiddleware` route protection, `UserButton` in the dashboard shell
- **Prisma** — PostgreSQL with `User` (linked to Clerk via `clerkUserId`) and `Subscription` models
- **Stripe billing** — subscription webhook handler with signature verification (`metadata.userId` = Prisma `User.id`)
- **Tailwind CSS v3** — utility-first styling, responsive dashboard layout
- **Landing page** — hero section with CTA buttons
- **Dashboard layout** — sidebar navigation, metric cards

## Prerequisites

- Node 20+
- PostgreSQL (local or hosted)
- [Clerk](https://clerk.com) application (API keys)
- Stripe account (for billing features)

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

| Variable | Description |
| -------- | ----------- |
| `DATABASE_URL` | PostgreSQL connection string |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (`pk_test_...` / `pk_live_...`) |
| `CLERK_SECRET_KEY` | Clerk secret key (`sk_test_...` / `sk_live_...`) |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Path hosting `<SignIn />` (default `/login`) |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Path hosting `<SignUp />` (default `/register`) |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | Post sign-in redirect when none is specified |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | Post sign-up redirect when none is specified |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |

Create a Clerk application at [dashboard.clerk.com](https://dashboard.clerk.com), copy the keys into `.env`, and add `http://localhost:3000` to allowed origins / redirect URLs as prompted in the Clerk dashboard.

## Clerk + Stripe

The dashboard calls `syncClerkUser()` on first load so a Prisma `User` row exists before Stripe webhooks attach subscriptions. When creating Stripe Checkout sessions, set `metadata: { userId: '<prisma User.id>' }` so the webhook in `app/api/webhooks/stripe/route.ts` can link rows correctly.

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
3. Add all environment variables in the Vercel dashboard (including Clerk keys and sign-in URL envs)
4. Deploy

### Other platforms

```bash
npm run build
npm start
```

Ensure `DATABASE_URL` points to a production PostgreSQL instance and run `npm run db:push` (or `prisma migrate deploy` for production migrations) before starting.
