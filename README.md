# SiaPOS

---

a Simple Industry Agnostic Point Of Sale System

## Setup

1. Create the secret files (the two database passwords and the key that protects gift card codes). Never commit them: `.gitignore` isn't tracked, so check `git status` before every commit.
   ```sh
   mkdir -p sql/secrets
   openssl rand -base64 24 > sql/secrets/root_password.txt
   openssl rand -base64 24 > sql/secrets/app_user_password.txt
   openssl rand -base64 24 > sql/secrets/giftcard_secret.txt
   ```
2. Start everything: `docker compose up -d` (for development with the demo shop, see below). MySQL listens on `127.0.0.1:3306` only, and the app on port 3000.

The scripts in `sql/init_scripts/` run only when the database volume is empty. After changing them, rebuild the database (this **deletes all its data**):

```sh
docker compose down -v && docker compose up -d
```

If `posdb` stays `unhealthy`, an init script failed: check `docker logs posdb`.

The demo shop and the known dev PINs live in `sql/dev/` and are **not** loaded by default. `05-dev-seed.sql` is a demo coffee shop (Brewbean Coffee: two cafés, two weeks of orders, staff shifts) and `06-dev-credentials.sql` gives its staff PINs (owner Maya `111111`, manager Leo `222222`, servers Sam `333333` and Priya `444444`, barista Jordan `555555`, assistant manager Ana `666666`). Load them for development with:

```sh
docker compose down -v
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d
```

The demo gift card `dev-seed-card-0001` only matches the dev secret `dev-giftcard-secret`; put that in `sql/secrets/giftcard_secret.txt` for development.

## Orders

`/orders.html` searches orders (From and To date, Location, Employee, Status; today by default) and lists the newest 200, with the full count shown. Each row links to `/order.html?id=…`: items with options, totals, payments and refunds, who and where, and the status history. "Refund this order" opens the same refund screen the register uses (`public/js/refund.js`) on that order: a manager signs with number and PIN, anyone else sends it to a manager. Both pages and `/api/orders` need the "Search orders" permission (16) and only show orders at the caller's own locations. Adjusting a tip isn't built yet; its button is disabled.

## Going live

Passwords and PINs cross the network, so serve the app over HTTPS: put a reverse proxy with a certificate in front of it, and publish the app's port to the proxy only (`127.0.0.1:3000:3000` in `docker-compose.yaml`), not to the café network. Then set `COOKIE_SECURE=1` (the session cookie is only sent over HTTPS) and `TRUST_PROXY=1` (the sign-in limit counts each person's own address, not the proxy's) in a `.env` file next to `docker-compose.yaml`. Both default to off, which is right for `localhost` development.

## Signing out

A sign-in lasts at most 8 hours, and ends sooner after 15 minutes without activity (`server/session.js`). Clicks, keys and scrolling count as activity; a page refreshing itself, like Live sales, does not. Every page shows a notice at 5 minutes and at 1 minute before the sign-out, with a Stay signed in button (`public/js/shell.js`). The server is the one that signs out, so the 15 minutes are written in both files.

## Tests

`npm test` (or `sql/tests/run.sh`) builds the schema into a throwaway database inside the running `posdb` container and runs every database rule test as `app_user`. Run it before rebuilding the volume, so schema errors show up there first. It also runs the pricing unit tests (`tests/unit`, no database needed).

`npm run test:live` starts the app against the dev database and runs the API tests (`tests/live/api.test.js`) and a browser-page click-through (`tests/live/click-through.js`). It needs the dev data above and adds a few test sales to it each run.
