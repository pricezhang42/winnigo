# Deployment: one Oracle Cloud server

Runbook, 2026-11-24. Winnigo runs on one Oracle Cloud "Always Free" ARM server with Docker
Compose ([compose.production.yaml](../compose.production.yaml)). Photos and database backups
live in Cloudflare R2. This replaces the hosting part of P8 (#10) for the first launch; the
original site and its Facebook collector are not touched.

## What runs where

| Piece | Where |
| --- | --- |
| Website (`web`), collection worker (`worker`), PostgreSQL 17 (`postgres`) | Docker containers on the server |
| HTTPS certificate and proxy (`caddy`) | Docker container on the server; ports 80 and 443 |
| Event photos | R2 bucket `winnigo-media` (private, served through `/api/photos/:id`) |
| Database backups | R2 bucket `winnigo-backups` (private), daily, 30 days |
| Email | Resend SMTP, from `no-reply@winnigo.lpzdev.com` |
| DNS | Porkbun: `winnigo.lpzdev.com` → the server's public IP |

`release` (migrations and the official trails) and `backup` are one-off containers from the same
image. Every setting is in `.env.production` on the server
([template](../.env.production.example)); it is never committed or pasted anywhere else.

## Launch stages

1. **Test site.** `WINNIGO_PUBLIC_BROWSING=disabled`, `WINNIGO_SIGNUP=invitation`,
   `WINNIGO_INDEXING=disabled`, Google app in Testing. Only invited accounts can sign in.
2. **Public.** When the owner decides: `WINNIGO_PUBLIC_BROWSING=enabled`, `WINNIGO_SIGNUP=open`,
   publish the Google app, and optionally `WINNIGO_INDEXING=enabled` (robots.txt and
   `X-Robots-Tag` follow it). Then `deploy/compose.sh up -d` to apply.

Event photos are shown to everyone. The owner accepted on 2026-11-24 that the sources' terms for
showing their images have not been reviewed (docs/31).

## One-time setup

### 1. Cloudflare R2 (owner)

1. Create a Cloudflare account and enable R2 (free tier: 10 GB stored a month).
2. Create two private buckets: `winnigo-media` and `winnigo-backups`. No public access.
3. Create two R2 API tokens with **Object Read & Write**, each limited to one bucket. Note the
   access key and secret of each, and the S3 endpoint
   `https://ACCOUNT_ID.r2.cloudflarestorage.com`.

### 2. Oracle Cloud server (owner)

1. Create an Oracle Cloud account. Choose **Canada Southeast (Toronto)** or **(Montreal)** as the
   home region; it cannot be changed later. A card is needed for identity; nothing is charged
   within the Always Free limits.
2. Upgrade the account to **Pay As You Go** and add a budget alert (for example US$1). Oracle can
   reclaim idle Always Free servers on free-only accounts; Pay As You Go avoids that and still
   costs nothing within the limits.
3. Create an instance: shape **VM.Standard.A1.Flex** with **2 OCPUs and 12 GB** memory, image
   **Ubuntu 24.04 (aarch64)**, boot volume 50 GB, your SSH public key, a public IPv4 address.
   If Oracle reports no capacity, try another availability domain or try again later.
4. In the instance's subnet security list, allow ingress TCP 80 and 443 (and UDP 443) from
   0.0.0.0/0. Keep SSH (22) as it is.

### 3. Prepare the server

Connect with `ssh ubuntu@SERVER_IP`, then:

```sh
sudo apt update && sudo apt -y full-upgrade
sudo apt -y install unattended-upgrades docker.io docker-compose-v2 git
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
# Oracle's Ubuntu image has its own firewall rules; open HTTP and HTTPS there too.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save
sudo useradd --system --create-home --groups docker winnigo
sudo mkdir -p /opt/winnigo && sudo chown winnigo: /opt/winnigo
```

The repository is private: add a **read-only deploy key** for the server in GitHub
(Settings → Deploy keys), then as the `winnigo` user (`sudo -iu winnigo`):

```sh
ssh-keygen -t ed25519 -f ~/.ssh/github -N ''   # add ~/.ssh/github.pub as the deploy key
printf 'Host github.com\n  IdentityFile ~/.ssh/github\n' >> ~/.ssh/config
git clone git@github.com:pricezhang42/winnigo.git /opt/winnigo
cd /opt/winnigo && cp .env.production.example .env.production && chmod 600 .env.production
```

Fill in `.env.production` on the server (`nano .env.production`). Use new values for
`POSTGRES_PASSWORD` (`openssl rand -hex 24`), `BETTER_AUTH_SECRET` (`openssl rand -base64 48`)
and `WINNIGO_COLLECTOR_KEY`; never the local ones. Use the **rotated** Resend key and Google
client secret.

### 4. DNS (owner)

At Porkbun, add an **A** record: host `winnigo`, answer the server's public IP, TTL 600. Wait
until `dig +short winnigo.lpzdev.com` returns that IP before the first start, so Caddy can get
the certificate.

### 5. First start

As `winnigo` in `/opt/winnigo`:

```sh
deploy/compose.sh build
deploy/compose.sh up -d postgres
deploy/compose.sh run --rm release
deploy/compose.sh up -d
curl -fsS https://winnigo.lpzdev.com/api/health
```

Then create the owner: invite your address, sign up at `/login` with "I have an invitation" (or
Google), verify the email, and promote the account:

```sh
deploy/compose.sh run --rm web node scripts/manage-accounts.mjs invite you@example.com
deploy/compose.sh run --rm web node scripts/manage-accounts.mjs bootstrap-owner you@example.com
```

With `WINNIGO_SCHEDULES=enabled` the worker registers the daily schedules (docs/17). Start a
first collection from the admin page or wait for 06:00.

### 6. Backups

```sh
sudo cp deploy/winnigo-backup.service deploy/winnigo-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now winnigo-backup.timer
sudo systemctl start winnigo-backup.service && journalctl -u winnigo-backup -n 20
deploy/compose.sh run --rm backup node scripts/backup-database.mjs --list
```

**Restore test** (do this once after the first backup, and after major changes). It restores the
newest dump into a new database beside the live one and prints row counts to compare:

```sh
deploy/compose.sh run --rm backup node scripts/restore-database.mjs --into winnigo_restore_test
deploy/compose.sh exec postgres dropdb -U winnigo winnigo_restore_test
```

Photos are not backed up separately: R2 keeps them durably, and a lost photo is copied again
from its source on the next collection run.

## Updating

```sh
cd /opt/winnigo && git pull --ff-only
deploy/compose.sh build
deploy/compose.sh run --rm backup          # a fresh dump before migrating
deploy/compose.sh run --rm release
deploy/compose.sh up -d
deploy/compose.sh ps
```

**Rollback.** Check out the previous commit, build and `up -d`. Migrations only move forward; if
a migration must be undone, restore the pre-update dump into a new database
(`restore-database.mjs --into winnigo_rollback`), check it, then point `DATABASE_URL` at it by
renaming databases while `web` and `worker` are stopped. Never restore an old dump over data
people have added since without reconciling it.

## Operating

- Status and logs: `deploy/compose.sh ps`, `deploy/compose.sh logs -f --tail 100 web worker`.
  Logs are capped at 50 MB per container.
- Collection runs, failures and the event review list: the admin page. Remaining duplicate
  candidates: `deploy/compose.sh run --rm web node scripts/event-duplicates.mjs`.
- Accounts: the Users panel; `accounts:cleanup` removes unverified accounts and expired sessions
  (`deploy/compose.sh run --rm web node scripts/cleanup-accounts.mjs --apply`).
- AI spend: the per-run budget (`WINNIGO_EXTRACTION_RUN_BUDGET_USD`) and an OpenAI usage limit.
- Disk: `df -h` and `docker system df`; prune old images with `docker image prune`.

## Secrets

- `.env.production` is readable only by `winnigo` (mode 600). Backups never include it.
- **Rotate `BETTER_AUTH_SECRET`** if the database or a backup may have been exposed: it signs
  everyone out and invalidates stored Google tokens (they are only used at sign-in). Edit the
  value, then `deploy/compose.sh up -d`.
- Rotate the Resend key, the Google client secret, the R2 tokens and the OpenAI key at their
  providers, update `.env.production`, then `deploy/compose.sh up -d`.

## Security notes

- Caddy terminates HTTPS and replaces `X-Forwarded-For` with the visitor's address, which the
  sign-in rate limits use (in memory; IP addresses are not stored).
- The app sets HSTS, a Content-Security-Policy, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy` and `nosniff` on every response (lib/security-headers.mjs).
- PostgreSQL is reachable only inside the Docker network; only ports 80 and 443 are public.
