# SiaPOS

---

a Simple Industry Agnostic Point Of Sale System

## Setup

1. Create the two database password files. Never commit them: `.gitignore` isn't tracked, so check `git status` before every commit.
   ```sh
   mkdir -p sql/secrets
   openssl rand -base64 24 > sql/secrets/root_password.txt
   openssl rand -base64 24 > sql/secrets/app_user_password.txt
   ```
2. Start everything: `docker compose up -d`. MySQL listens on `127.0.0.1:3306` only, and the app on port 3000.

The scripts in `sql/init_scripts/` run only when the database volume is empty. After changing them, rebuild the database (this **deletes all its data**):

```sh
docker compose down -v && docker compose up -d
```

If `posdb` stays `unhealthy`, an init script failed: check `docker logs posdb`.

`05-dev-seed.sql` fills the database with a demo coffee shop (Brewbean Coffee: two cafés, two weeks of orders, staff shifts). It is for development only; leave it out of a production build.

## Tests

`npm test` (or `sql/tests/run.sh`) builds the schema into a throwaway database inside the running `posdb` container and runs every database rule test as `app_user`. Run it before rebuilding the volume, so schema errors show up there first.
