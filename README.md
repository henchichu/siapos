# BrewBean POS System

## Setup

Prerequisites:

**Only Tested on MacOS and Linux (If on Windows, use WSL)**

Install Docker Engine (not to be confused with Docker Desktop, they aren't the same, and the subsequent steps in this guide assume you are using the engine): https://docs.docker.com/engine/install/

1. Create the secret files (the database passwords). 

Run these commands at the root of the source files:

   ```sh
   mkdir -p sql/secrets
   openssl rand -base64 24 > sql/secrets/root_password.txt
   openssl rand -base64 24 > sql/secrets/app_user_password.txt
   ```
   The database container reads these files as another user, so they must be world-readable: run `chmod 644 sql/secrets/*.txt` if a file is private (mode 600).


2. Build the application by running one of the two following commands:

#### This starts the application with the demo data on port 3000 with no outside db access (network isolation)

```sh
	docker compose up -d
```

#### This starts the application with the demo data on port 3000 and outside db access on port 3306
```sh
	docker compose -f docker-compose.yaml -f docker-compose.test.yaml up -d
```

#### Use these commands to remove related docker resources after use: use the one that matches the one you used to start the stack
```sh
	docker compose down -v
 
	docker compose -f docker-compose.yaml -f docker-compose.test.yaml down -v
```
 
3. Sign In Information is located in the 'SIGN-IN TEAM 5 Passwords&Usernames.docx' file.

