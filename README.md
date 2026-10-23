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

The demo shop and the known dev PINs live in `sql/dev/` and are **not** loaded by default. `05-dev-seed.sql` is a demo coffee shop (Brewbean Coffee: two cafés, two weeks of orders, staff shifts) and `06-dev-credentials.sql` gives its staff PINs (owner Maya `111111`, manager Leo `222222`, servers Sam `333333` and Priya `444444`, barista Jordan `555555`, assistant manager Ana `666666`; their employee numbers are `10420001` to `10420006` in that order). Load them for development with:

```sh
docker compose down -v
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d
```

The demo gift card `dev-seed-card-0001` only matches the dev secret `dev-giftcard-secret`; put that in `sql/secrets/giftcard_secret.txt` for development.

## Customer kiosk

The customer iPad opens `/customer` (no staff sign-in): browse the menu, sign in by phone number or continue as a guest, and place an order that waits for payment at the counter. Set `KIOSK_LOCATION_ID` to the café's id (`docker-compose.dev.yaml` sets the demo café's); with more than one café and no id, the kiosk refuses to guess. A customer is signed out after 2 minutes without a touch (30 seconds after placing an order), and the server ends the session after 5. Card, Apple Pay and Google Pay are mock-paid on the kiosk (see Mock payments), and the order goes straight to the kitchen. A Cash order waits for the counter, and nothing on the staff side takes that payment yet.

## Public kiosk address (ngrok)

The app runs two servers. Port 3000 is the staff side (the tills, and the kiosk iPad on the café network). Port 3001 (`server/kiosk.js`) is the public side: it serves only the kiosk page and `/api/customer/*`, so the staff pages and API don't exist there. Phone sign-in is off on it, because a phone number alone isn't enough to protect someone's order history on the internet, so customers order as guests. Port 3001 isn't published to the host: only the `ngrok` service can reach it. To open it to the internet, put `NGROK_AUTHTOKEN` and `NGROK_DOMAIN` (your static ngrok domain) in a `.env` file next to `docker-compose.yaml` and run `docker compose --profile tunnel up -d`. Keep port 3000 off the internet; reach it from elsewhere over an SSH tunnel (`ssh -L 3000:localhost:3000 <host>`). Anyone with the address can still place unpaid cash orders, which take stock (rate-limited to 20 a minute), so share it only for testing.

## Mock payments

There is no real card processor. `server/mockpay.js` stands in for one at the registers and on the customer kiosk: Card, Apple Pay and Google Pay are approved or declined by the mock, no money moves, and no card detail is stored or logged. Apple Pay and Google Pay always succeed. For Card, only test numbers are accepted (any other number, including a real card, is refused): `4242 4242 4242 4242` approves, `4000 0000 0000 0002` is declined, `4000 0000 0000 9995` has insufficient funds, `4000 0000 0000 0069` is expired, and `4000 0000 0000 0119` is a processor error. Use any expiry that hasn't passed (like `12/49`) and any 3 or 4 digit code. A decline makes no order. A database made before this needs the `APPLE_PAY` (5) and `GOOGLE_PAY` (6) rows in `PaymentMethod`, which `02-seed.sql` adds to a fresh one.

## Going live

Passwords and PINs cross the network, so serve the app over HTTPS: put a reverse proxy with a certificate in front of it, and publish the app's port to the proxy only (`127.0.0.1:3000:3000` in `docker-compose.yaml`), not to the café network. Then set `COOKIE_SECURE=1` (the session cookie is only sent over HTTPS) and `TRUST_PROXY=1` (the sign-in limit counts each person's own address, not the proxy's) in a `.env` file next to `docker-compose.yaml`. Both default to off, which is right for `localhost` development.

## Signing out

A sign-in lasts at most 8 hours, and ends sooner after 15 minutes without activity (`server/session.js`). Clicks, keys and scrolling count as activity; a page refreshing itself, like Live sales, does not. Every page shows a notice at 5 minutes and at 1 minute before the sign-out, with a Stay signed in button (`public/js/shell.js`). The server is the one that signs out, so the 15 minutes are written in both files.

## Tests

`npm test` (or `sql/tests/run.sh`) builds the schema into a throwaway database inside the running `posdb` container and runs every database rule test as `app_user`. Run it before rebuilding the volume, so schema errors show up there first. It also runs the pricing unit tests (`tests/unit`, no database needed).

`npm run test:live` starts the app against the dev database and runs the API tests (`tests/live/api.test.js`) and a browser-page click-through (`tests/live/click-through.js`). It needs the dev data above and adds a few test sales to it each run.
