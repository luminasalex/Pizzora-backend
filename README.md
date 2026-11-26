# Pizzora API

Express 5 API for Pizzora. It uses the MongoDB Native Driver and hosts Better Auth so that authentication, authorization, menu, order, profile, and subscription rules are enforced server-side. Better Auth's JWT plugin issues short-lived, signed access tokens; protected Express routes verify Bearer tokens and load current user roles and status from MongoDB.

## Technology

- `express`, `mongodb`, and `dotenv`
- `better-auth` with `@better-auth/mongo-adapter` and the JWT plugin
- `stripe` for vendor Premium subscriptions; `cors` for the configured client origin
- Premium vendors can publish unlimited active items; Free vendors can publish up to 3 active items.

## Requirements

- Node.js 20 or newer
- MongoDB Atlas or another MongoDB deployment
- Optional: Google OAuth, Stripe Billing, and ImgBB credentials

## Local development

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

Set `MONGODB_URI`, a strong `BETTER_AUTH_SECRET` (at least 32 characters), and the client/API origins before starting. Generate a secret with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Run checks:

```powershell
npm test
npm run check
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Express listening port; defaults to `3001` |
| `NODE_ENV` | Enables secure cross-origin cookies in production |
| `CLIENT_URL` | Comma-separated allowed frontend origins |
| `BETTER_AUTH_URL` | Public origin of this API and Better Auth |
| `BETTER_AUTH_SECRET` | Better Auth signing/encryption secret; keep private |
| `MONGODB_URI` | MongoDB connection string; keep private |
| `DB_NAME` | MongoDB database name; defaults to `Pizzora` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional Google OAuth credentials |
| `STRIPE_SECRET_KEY` | Stripe server-side API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_ID` | Stripe recurring Premium price |
| `IMGBB_API_KEY` | Server-side ImgBB upload credential |

Google OAuth's callback URL is `BETTER_AUTH_URL/api/auth/callback/google`. Add the exact callback URL to the Google OAuth client. JWT signing keys are stored and encrypted in MongoDB through Better Auth's `jwks` collection.

## API overview

- `GET /health`
- Better Auth: `/api/auth/*` (includes `/api/auth/token` for short-lived JWT issuance)
- Public menu: `GET /api/menu-items`, `/api/menu-items/featured`, `/api/menu-items/:id`, `/api/categories`
- Vendor menu: `GET /api/vendor/menu-items`, `POST/PATCH/DELETE /api/menu-items/*`
- Menu review and user management: `/api/admin/*`
- Orders: `POST /api/orders`, `GET /api/orders/my-orders`, `GET /api/vendor/orders`, `PATCH /api/orders/:id/:action`
- Profile and image uploads: `PATCH /api/users/profile`, `POST /api/uploads/images`
- Dashboards: `/api/dashboard/customer`, `/api/dashboard/vendor`, `/api/dashboard/admin`
- Vendor subscriptions: `/api/subscriptions/current`, `/api/subscriptions/checkout`, `/api/subscriptions/cancel`
- Stripe webhook: `POST /api/webhooks/stripe`

Menu query parameters include `search`, `category`, `location`, `sort=price_asc|price_desc`, `page`, and `limit`. Only approved and available items from non-blocked vendors are returned publicly.

## Authorization and data

Protected Express routes require a valid Bearer JWT. The JWT plugin verifies its signature, expiration, issuer, and audience; Express then gets the role and blocked state from the authoritative user record rather than trusting JWT role claims. The token lifetime is ten minutes. Vendor ownership, order ownership, menu approval, free-plan limits, and subscription state are checked on the server. Admin accounts are not created through public registration; promote an existing account with:

```powershell
npm run promote-admin -- owner@example.com
```

Better Auth manages its user, session, account, and verification storage. Business data uses `menuItems`, `orders`, and `transactions`; `webhookEvents` stores Stripe event IDs for idempotent webhook handling.

The order duplicate guard uses a unique sparse `activeOrderKey` index. Stripe subscriptions activate only after a signed webhook verifies payment; checkout redirect pages never grant Premium access.

## Stripe local webhook

Configure `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, and `STRIPE_WEBHOOK_SECRET`. For local testing with the Stripe CLI:

```powershell
stripe listen --forward-to localhost:3001/api/webhooks/stripe
```

Forward to the port the API is actually listening on (`3001` by default; use `5000` when `PORT=5000`). Copy the CLI's webhook signing secret to `.env` as `STRIPE_WEBHOOK_SECRET`, then restart the API. Keep the listener running while testing and complete a new checkout after it starts. Customer pizza orders do not use Stripe Checkout.

## Submission links

- Live website: https://pizzora-client-ten.vercel.app/
- Live API URL: Not provided
- Client GitHub repository: Not configured in this workspace
- API repository: https://github.com/luminasalex/-Pizzora-backend

## Deployment

### Vercel

The Express app is configured for Vercel serverless deployment. Import this `server` repository as a Vercel project and set these environment variables:

- `MONGODB_URI`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL=https://<your-api-domain>.vercel.app`
- `CLIENT_URL=https://<your-client-domain>`
- `NODE_ENV=production`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_ID` when billing is enabled
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for Google OAuth
- `IMGBB_API_KEY` for server-side image uploads

Set the Stripe webhook endpoint to `https://<your-api-domain>.vercel.app/api/webhooks/stripe`. Allow Vercel's network access to MongoDB Atlas (or allow database network access for serverless IP egress). The project includes `vercel.json`, which routes all requests to the Express app.

For a Render or other Node.js deployment, configure MongoDB network access, production `CLIENT_URL` and `BETTER_AUTH_URL`, OAuth callback origins, Stripe webhook URL (`/api/webhooks/stripe`), and the server-only ImgBB key. Use a same-site domain or reverse proxy for reliable auth cookies.

Do not commit `.env` or publish server credentials.
