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

The demo shop and the known dev PINs live in `sql/dev/` and are **not** loaded by default. `05-dev-seed.sql` is a demo coffee shop (Brewbean Coffee: two cafés, two weeks of orders, staff shifts) and `06-dev-credentials.sql` gives its staff PINs (owner Maya `111111`, manager Leo `222222`, servers Sam `333333` and Priya `444444`, barista Jordan `555555`). Load them for development with:

```sh
docker compose down -v
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d
```

The demo gift card `dev-seed-card-0001` only matches the dev secret `dev-giftcard-secret`; put that in `sql/secrets/giftcard_secret.txt` for development.


## Products

`/products.html` shows a read-only list (name, sizes, category, price from, available) to anyone with permission 11. With permission 12 it becomes four tabs: Products, Sizes and recipes, Option groups, Promotions. Costs and margins need permission 13. Photos are saved under `UPLOAD_DIR` (a Docker volume, `/app/uploads`) and only their key is stored in the database; they are limited to PNG, JPEG or WebP up to 2 MB.

## Tests

`npm test` (or `sql/tests/run.sh`) builds the schema into a throwaway database inside the running `posdb` container and runs every database rule test as `app_user`. Run it before rebuilding the volume, so schema errors show up there first. It also runs the pricing unit tests (`tests/unit`, no database needed).

`npm run test:live` starts the app against the dev database and runs the API tests (`tests/live/api.test.js`) and a browser-page click-through (`tests/live/click-through.js`). It needs the dev data above and adds a few test sales to it each run.
