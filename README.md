# SiaPOS

---

a Simple Industry Agnostic Point Of Sale System

## Setup

1. Create the secret files (the database passwords and the key that protects gift card codes). Never commit them: `.gitignore` isn't tracked, so check `git status` before every commit.
   ```sh
   mkdir -p sql/secrets
   openssl rand -base64 24 > sql/secrets/root_password.txt
   openssl rand -base64 24 > sql/secrets/app_user_password.txt
   openssl rand -base64 24 > sql/secrets/kiosk_user_password.txt
   openssl rand -base64 24 > sql/secrets/giftcard_secret.txt
   ```
   The database container reads these files as another user, so they must be world-readable: run `chmod 644 sql/secrets/*.txt` if a file is private (mode 600). Otherwise MySQL restarts in a loop with `Permission denied` and the app containers never start.

   Everything to set before the first start:

   | Secret file (`sql/secrets/`) | Used by | Notes |
   |---|---|---|
   | `root_password.txt` | MySQL root | required |
   | `app_user_password.txt` | `pos-api`'s database login (`app_user`) | required |
   | `kiosk_user_password.txt` | `kiosk-api`'s database login (`kiosk_user`, menu and orders only) | required: compose won't start without it |
   | `giftcard_secret.txt` | the key that protects gift card codes | required; for the demo shop it must be `dev-giftcard-secret` (see below) |

   | `.env` variable (next to `docker-compose.yaml`) | Default | Set it when |
   |---|---|---|
   | `KIOSK_HOST` | `localhost` | **deploying**: the public hostname for the order page (Caddy gets its certificate for it, and Settings shows each café's order link built on it) |
   | `COOKIE_SECURE` | `0` | the apps are served over HTTPS (`1`) |
   | `TRUST_PROXY` | `0` | the staff side sits behind a reverse proxy (`1`) |
   | `KIOSK_SHARED_DEVICE` | off | the order screen is one shared iPad (`1`: customers are signed out quickly) |
   | `DEMO_MODE` | off | a demo of the dev-seeded shop (`1`): the front page always shows the tour, and leaving it shows the demo sign-ins before the sign-in page. Never where real accounts exist: it hands out working PINs |
   | `MOCK_PAY` | off | never in `.env`: the dev compose file sets it (`1`: the public page also offers Card, Apple Pay and Google Pay through the mock processor, which takes no money). Production offers Cash only |
   | `KIOSK_PHONE_SIGNIN` | off | a demo with made-up customers (`1`: phone-number sign-in on the public address; the dev compose file sets it) |

   None of the `.env` variables is needed for local development. Everything else (database host and logins, ports, pool sizes, uploads folder) is set in `docker-compose.yaml`.

2. Start everything: `docker compose up -d` (for development with the demo shop, see below). MySQL listens on `127.0.0.1:3306` only and the staff app (`pos-api`) on `127.0.0.1:3000`. The public order server (`kiosk-api`) is reached through Caddy, which only starts with `--profile public` (see Containers); the dev compose file also publishes it on `127.0.0.1:3001`, so the demo shop's order page opens at `http://127.0.0.1:3001/order/loc-campus`.

The scripts in `sql/init_scripts/` run only when the database volume is empty. After changing them, rebuild the database (this **deletes all its data**):

```sh
docker compose down -v && docker compose up -d 
```

If `posdb` stays `unhealthy`, an init script failed: check `docker logs posdb`.

The demo shop and the known dev PINs live in `sql/dev/` and are **not** loaded by default. `05-dev-seed.sql` is a demo coffee shop (Brewbean Coffee: two cafés, two weeks of orders, staff shifts) and `06-dev-credentials.sql` gives its staff PINs (owner Maya `111111`, manager Leo `222222`, servers Sam `333333` and Priya `444444`, barista Jordan `555555`, assistant manager Ana `666666`; their employee numbers are `10420001` to `10420006` in that order). Load them for development with:

```sh
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml down -v 
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d
```

The demo gift card `dev-seed-card-0001` only matches the dev secret `dev-giftcard-secret`; put that in `sql/secrets/giftcard_secret.txt` for development.

## Phone ordering

Each café has its own QR code that opens `https://<KIOSK_HOST>/order/<café id>`: customers order on their own phone, in the café, as a guest or (demo only) by phone number, and pay in the page or choose Cash and pay at the counter. The café comes from that link, so one app serves every café of the business. Settings > Locations shows each café's link (select it and paste it into any QR maker). An address that names no café, or a closed or unknown one, is refused; `/` and `/customer` go to the café when the business has only one.

- Card, Apple Pay and Google Pay are mock-paid (see Mock payments) and the order goes straight to the kitchen. A Cash order waits as "payment pending" and holds its stock for 15 minutes: the register's **Kiosk orders** window takes the cash or cancels it, and one nobody pays is cancelled by itself, which puts the stock back.
- The phone shows the order's live status (paid, preparing, ready for pickup, cancelled) and checks every 8 seconds.
- Sessions: a customer stays signed in on their own phone. For one shared iPad at the counter set `KIOSK_SHARED_DEVICE=1`: customers are signed out after 2 minutes without a touch (30 seconds after an order), and the server after 5.
- Several businesses share the app: each café's QR link (`/order/<location id>`) decides the café and so the business. Opened without one, the page says to scan the café's QR code. A phone signed in at one business is a guest at another's café.

## Containers and the public address (Azure VM)

Three services plus the proxy; the two app services are built from the same image:

| Service | What it is | Reachable | Database login |
|---|---|---|---|
| `pos-api` | staff side: registers, kitchen, timecards, reports, Settings; also cancels unpaid kiosk orders and tells open kitchen screens about orders the public side took | `127.0.0.1:3000` only | `app_user` (pool of 15) |
| `kiosk-api` | the order page and `/api/customer/*`, nothing of the staff side | the `caddy` service only | `kiosk_user` (pool of 8): reads the menu and writes orders, **cannot read** staff, PINs, pay, timecards or refunds |
| `mysql-db` | MySQL 8.4 | `127.0.0.1:3306` only | |
| `caddy` (`--profile public`) | HTTPS for `KIOSK_HOST`, forwards to `kiosk-api` | ports 80 and 443 | |

Reach the staff side from elsewhere over a private network (Tailscale or a VPN, or an SSH tunnel: `ssh -L 3000:localhost:3000 <user>@<host>`), not the internet. Kitchen screens learn about orders from the other container because `pos-api` checks the database every 2 seconds, only for cafés that have a kitchen screen open.

**Rate limits** (public side, in memory): a café's phones share one address, so the limits are layered. Per address: 1,500 requests a minute (menu pictures not counted) and 60 orders a minute, high enough for a rush. Per phone (a `device` cookie): 5 orders and 10 sign-ins a minute, which stops one script without touching the other phones. An address that goes over its limit in 3 different minutes within 10 is blocked for 15 minutes. Staff sign-in is limited to 30 a minute per address, and an account locks for 15 minutes after 5 wrong PINs.

## Capacity

Measured with `tests/load/run.js` (60 phones and 4 registers ordering at once, on a developer machine with the database on the same host, mock payments, one product): a realistic rush of 14 orders a second ran with orders answered in about 10 ms (p95 20 ms). With every pause removed (`--hammer`) the stack took about 160 orders a second in total, with the slowest 1% of order requests under 0.4 s. Treat that as the ceiling for tiny orders on this hardware: a real card processor adds its own delay to every order and the numbers will be lower with larger orders and on a smaller VM. Run it against your own VM before relying on it:
```sh
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml -f docker-compose.load.yaml up -d kiosk-api   # lifts the public limits for the test only
node tests/load/run.js --phones 60 --registers 4 --seconds 20
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d kiosk-api                              # put the limits back
```
Known limits: every order takes the business's order-number counter for the length of its transaction (so cafés of one business share it); sessions, rate limits and the "same order twice" memory live in each server's memory, so each service runs as one copy; before a real card processor is connected, authorise the card first and create the order in a short transaction.

## Mock payments

There is no real card processor. `server/mockpay.js` stands in for one at the registers and on the phone order page: Card, Apple Pay and Google Pay are approved or declined by the mock, no money moves, and no card detail is stored or logged. Apple Pay and Google Pay always succeed. For Card, only test numbers are accepted (any other number, including a real card, is refused): `4242 4242 4242 4242` approves, `4000 0000 0000 0002` is declined, `4000 0000 0000 9995` has insufficient funds, `4000 0000 0000 0069` is expired, and `4000 0000 0000 0119` is a processor error. Use any expiry that hasn't passed (like `12/49`) and any 3 or 4 digit code. A decline makes no order.

## Going live

The public order page is already behind HTTPS (Caddy). The staff side listens on `127.0.0.1:3000` only, so reach it through a tunnel or private network (see Containers), which encrypts it. If you ever put the staff side on a network some other way, passwords and PINs would cross it, so serve it over HTTPS first: a reverse proxy with a certificate in front, then `COOKIE_SECURE=1` (the session cookie is only sent over HTTPS) and `TRUST_PROXY=1` (the sign-in limit counts each person's own address, not the proxy's) in a `.env` file next to `docker-compose.yaml`. Both default to off, which is right for `localhost` development.

## Signing out

A sign-in lasts at most 8 hours, and ends sooner after 15 minutes without activity (`server/session.js`). Clicks, keys and scrolling count as activity; a page refreshing itself, like Live sales, does not. Every page shows a notice at 5 minutes and at 1 minute before the sign-out, with a Stay signed in button (`public/js/shell.js`). The server is the one that signs out, so the 15 minutes are written in both files.

## Tests

`npm test` (or `sql/tests/run.sh`) builds the schema into a throwaway database inside the running `posdb` container and runs every database rule test as `app_user`. Run it before rebuilding the volume, so schema errors show up there first. It also runs the unit tests (`tests/unit`: pricing, sessions, form validation, rate limits, dates, mock payments; no database needed).

`npm run test:live` starts the apps against the dev database and runs the API tests (`tests/live/*.test.js`) and the browser-page click-throughs (`tests/live/*-click.js`, in jsdom). It needs the dev data above, the database port from the dev compose file, and `sql/secrets/kiosk_user_password.txt` (one test starts the public server as `kiosk_user`). It adds test sales and orders to the dev data each run. `tests/load/run.js` is the load test (see Capacity).

## Settings

Sign in again after rebuilding, then open Settings from Home or the sidebar. General requires permission 21; Roles and permissions requires permission 22. Owners have both implicitly. A manager without these permissions will not see Settings.

General saves business details, tax inclusion, refund limits, categories, locations, location tax percentages and register names. Blank refund limits disable that limit. Existing registers are retained. Reassign active staff before deactivating a location or role.

Role names do not determine navigation. Permission checkboxes determine available pages. The Owner role is locked; only owners can manage senior roles. Saving a role signs its staff out so access is refreshed at their next login.

Settings smoke checks run against the running development app and demo owner account, from the project root:

```sh
node tests/live/settings-ui-smoke.cjs
node tests/live/settings-write-smoke.cjs
```

The write check creates temporary records and removes them afterward. Keep local secrets, node_modules and any personal .gitignore out of commits using .git/info/exclude.
