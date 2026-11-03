# SiaPOS

---

a Simple Industry Agnostic Point Of Sale System

## Setup

1. Create the secret files (the database passwords). Never commit them: `.gitignore` isn't tracked, so check `git status` before every commit.
   ```sh
   mkdir -p sql/secrets
   openssl rand -base64 24 > sql/secrets/root_password.txt
   openssl rand -base64 24 > sql/secrets/app_user_password.txt
   openssl rand -base64 24 > sql/secrets/kiosk_user_password.txt
   ```
   The database container reads these files as another user, so they must be world-readable: run `chmod 644 sql/secrets/*.txt` if a file is private (mode 600). Otherwise MySQL restarts in a loop with `Permission denied` and the app containers never start.

   Everything to set before the first start:

   | Secret file (`sql/secrets/`) | Used by | Notes |
   |---|---|---|
   | `root_password.txt` | MySQL root | required |
   | `app_user_password.txt` | `pos-api`'s database login (`app_user`) | required |
   | `kiosk_user_password.txt` | `kiosk-api`'s database login (`kiosk_user`, menu and orders only) | required: compose won't start without it |

   | `.env` variable (next to `docker-compose.yaml`) | Default | Set it when |
   |---|---|---|
   | `KIOSK_HOST` | `localhost` | **deploying**: the public hostname for the order page (Caddy gets its certificate for it; each café's order link is built on it) |
   | `COOKIE_SECURE` | `0` | the apps are served over HTTPS (`1`) |
   | `TRUST_PROXY` | `0` | the staff side sits behind a reverse proxy (`1`) |
   | `KIOSK_SHARED_DEVICE` | off | the order screen is one shared iPad (`1`: customers are signed out quickly) |
   | `DEMO_MODE` | off | a demo of the dev-seeded shop (`1`): the front page shows the tour, and leaving it shows the demo sign-ins before the sign-in page. Never where real accounts exist: it hands out working PINs |
   | `MOCK_PAY` | off | never in `.env`: the dev compose file sets it (`1`: the public page also offers Card, Apple Pay and Google Pay through the mock processor, which takes no money). Production offers Cash only |
   | `KIOSK_PHONE_SIGNIN` | off | a demo with made-up customers (`1`: phone-number sign-in on the public address; the dev compose file sets it) |

   None of the `.env` variables is needed for local development. Everything else (database host and logins, ports, pool sizes, uploads folder) is set in `docker-compose.yaml`.


## Setting up a business

The app has no screens for creating a business, cafés, roles, employees, tax rates or pay rates: they are rows you add with SQL. Everyone who signs in belongs to one café, and sees only that café's registers, stock, orders and reports. Reports cover just that café.

1. Start with an empty database (`docker compose up -d`, no dev files).
2. Hash the first employee's password (8 characters or more) and, if they will approve discounts and refunds, a 6-digit PIN: `node sql/provision/hash-password.js 'a long password'` and `node sql/provision/hash-pin.js 246810`.
3. Edit the values at the top of `sql/provision/provision.sql` (business, café, time zone, tax rates, first employee and email, pay-period start, the password and PIN hashes) and run it once:
   ```sh
   docker compose exec -T mysql-db sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mysql -uroot' < sql/provision/provision.sql
   ```
   It creates the business, one café with a register, five roles, the first employee (every permission, signs in at `/login.html` with their email and password) and a year of two-week pay periods.
4. Add products and stock in the app (Products, Inventory), and the rest of the team with `sql/provision/maintenance.sql`.

`sql/provision/maintenance.sql` holds the statements for everything else: adding or switching off an employee, new passwords and PINs, unlocking an account, raises, roles and permissions, a second café (with its tax rates), refund limits, categories and more pay periods. Pay periods run out after a year, and nobody can clock in once they have. A timecard may be approved by the person who owns it, and so may a discount or refund override: anyone holding the permission can sign.

## Signing in and approvals

Staff sign in with an email and a password of 8 characters or more. The email is the sign-in name and is unique across the app (one person, one account, one business); it is not case-sensitive. Five wrong passwords lock the account for 15 minutes, and a wrong email and a wrong password get the same answer. A new password, or a cleared lock, is a statement in `sql/provision/maintenance.sql`; the app sends no email, so there is no "forgot password" link.

The **employee number** (8 digits) is not a secret: it names a colleague (for a staff discount) and, with the **approval PIN** (6 digits), lets a manager sign off a discount or refund at the till without signing in there. Wrong approval PINs count against the person asking, not the manager. Someone with no PIN simply cannot approve.

The dev shop (`sql/dev/`) signs in with each person's email and the password `<first name>-dev-pass`, for example `maya@brewbean.example.com` / `maya-dev-pass` (general manager Maya, manager Leo, servers Sam and Priya, barista Jordan, assistant manager Ana). Their employee numbers are `10420001` to `10420006` and their approval PINs `111111` to `666666`, in that order.
