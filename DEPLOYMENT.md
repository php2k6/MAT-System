# MAT System — Production Deployment Guide

A complete, step-by-step guide to deploying the MAT System (Momentum Automated Trading) platform on a cloud server using Docker Compose, with HTTPS via Cloudflare.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Server Setup](#3-server-setup)
4. [Clone & Configure](#4-clone--configure)
5. [Environment Variables](#5-environment-variables)
6. [Build & Launch](#6-build--launch)
7. [Domain & HTTPS Setup (Cloudflare)](#7-domain--https-setup-cloudflare)
8. [Fyers Broker Configuration](#8-fyers-broker-configuration)
9. [Day-to-Day Operations](#9-day-to-day-operations)
10. [Updating the Application](#10-updating-the-application)
11. [Troubleshooting](#11-troubleshooting)
12. [FAQ](#12-faq)

---

## 1. Architecture Overview

Docker Compose orchestrates **4 isolated containers** on a single private network:

```
                    ┌─────────────────────────────────────────────┐
                    │            Docker Internal Network           │
   Internet         │                                             │
   (Port 80) ──────▶│  ┌──────────┐     ┌──────────┐             │
                    │  │ Frontend │────▶│ Backend  │             │
                    │  │ (Nginx)  │     │ (FastAPI)│             │
                    │  └──────────┘     └────┬─────┘             │
                    │                        │                    │
                    │              ┌─────────┴─────────┐         │
                    │              │                    │         │
                    │         ┌────▼────┐         ┌────▼────┐    │
                    │         │  Redis  │         │Postgres │    │
                    │         │ (Cache) │         │  (DB)   │    │
                    │         └─────────┘         └─────────┘    │
                    └─────────────────────────────────────────────┘
```

| Container | Role | Exposed to Internet? |
|---|---|---|
| **Frontend (Nginx)** | Serves React app, reverse-proxies `/api/` to backend | ✅ Port 80 only |
| **Backend (FastAPI)** | Python API, scheduler, Fyers engine | ❌ Internal only |
| **PostgreSQL** | Users, strategies, trades, holdings | ❌ Internal only |
| **Redis** | Live price cache (sub-100ms LTP streaming) | ❌ Internal only |

> **Security:** Only Nginx is publicly accessible. The database, cache, and backend API are completely invisible to the internet. Nginx acts as the sole edge gateway.

---

## 2. Prerequisites

You need **only two things** installed on your server:

1. **Docker Engine** — [Install Guide](https://docs.docker.com/engine/install/ubuntu/)
2. **Docker Compose** (included with Docker Engine v2+)

You do **NOT** need to install Python, Node.js, Nginx, PostgreSQL, or Redis. Docker downloads and manages all of them automatically inside containers.

### Verify Installation
```bash
docker --version        # Should show 24.x or higher
docker compose version  # Should show v2.x or higher
```

### (Optional) Run Docker Without `sudo`
```bash
sudo usermod -aG docker $USER
newgrp docker
```

---

## 3. Server Setup

### 3.1 Recommended Providers
| Provider | Free Tier? | Notes |
|---|---|---|
| Oracle Cloud | ✅ Always Free (ARM 4 OCPU, 24GB RAM) | Best free option, requires firewall setup |
| DigitalOcean | ❌ ($6/mo) | Simplest setup |
| AWS EC2 | 12-month free tier | More complex networking |
| Hetzner | ❌ (€4/mo) | Best price-performance in EU |

### 3.2 Firewall Configuration

#### Oracle Cloud (Double Firewall — Both Steps Required!)

**Step A: Oracle Cloud Dashboard**
1. Go to **Networking → Virtual Cloud Networks (VCN)**
2. Click your VCN → Subnet → Default Security List
3. Click **Add Ingress Rules**:
   - Source CIDR: `0.0.0.0/0`
   - Source Port Range: *(Leave Blank)*
   - Destination Port Range: `80`
   - Click **Add Ingress Rule**
4. Repeat for port `443`

**Step B: Server Terminal (Ubuntu on Oracle)**
```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt install iptables-persistent -y
sudo netfilter-persistent save
```

#### DigitalOcean / AWS
- DigitalOcean: Networking → Firewalls → Allow HTTP (80) and HTTPS (443)
- AWS: EC2 → Security Groups → Edit Inbound Rules → Add HTTP and HTTPS from `0.0.0.0/0`

#### Ubuntu with UFW
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

---

## 4. Clone & Configure

```bash
# Clone the repository
git clone https://github.com/php2k6/MAT-System.git
cd MAT-System
```

---

## 5. Environment Variables

### 5.1 Understanding the Two `.env` Files

| File | Purpose | When is it read? |
|---|---|---|
| `backend/.env` | Database URLs, API keys, JWT secrets, scheduler config | **Runtime** — read when container starts |
| `frontend/.env` | `VITE_API_BASE_URL` | **Build time** — baked into JavaScript during `npm run build` |

### 5.2 Frontend `.env` (Set Once, Never Change)

```bash
echo "VITE_API_BASE_URL=/api" > frontend/.env
```

This uses a relative URL (`/api`), which means the browser automatically prepends whatever domain the user is on. **You never need to change this again**, regardless of which domain you use.

### 5.3 Backend `.env` (Full Production Template)

Create the file:
```bash
nano backend/.env
```

Paste the following and edit the marked values:

```env
# ═══════════════════════════════════════════════════════
# SECTION 1: NETWORKING & SECURITY
# ═══════════════════════════════════════════════════════

# Your domain (comma-separated). MUST match what users type in their browser.
ALLOWED_HOSTS=127.0.0.1,yourdomain.com

# Frontend origin for CORS. MUST include https:// if using Cloudflare.
FRONTEND_ORIGIN=https://yourdomain.com

# Set to true when behind HTTPS (Cloudflare, etc.)
COOKIE_SECURE=true

# ═══════════════════════════════════════════════════════
# SECTION 2: DATABASE & CACHE (Docker Internal Routing)
# ═══════════════════════════════════════════════════════
# IMPORTANT: Use 'db' and 'redis' as hostnames, NOT 'localhost'.
# Docker's internal DNS routes these to the correct containers.

DATABASE_URL=postgresql+psycopg2://postgres:yourpassword@db:5432/mat_system
REDIS_URL=redis://redis:6379/0
REDIS_PRICE_TTL_SECONDS=900
LIVE_PRICE_STALE_AFTER_SECONDS=90
LIVE_PRICE_REFRESH_SECONDS=15
FYERS_QUOTES_CHUNK_SIZE=50

# ═══════════════════════════════════════════════════════
# SECTION 3: AUTHENTICATION SECRETS
# ═══════════════════════════════════════════════════════
# Generate a strong random key (e.g. mash your keyboard for 30+ chars)

JWT_SECRET_KEY=CHANGE_THIS_TO_A_RANDOM_STRING_30_CHARS_OR_MORE
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=10080

# ═══════════════════════════════════════════════════════
# SECTION 4: FYERS BROKER API
# ═══════════════════════════════════════════════════════
# Get these from https://myapi.fyers.in after registering your app.

FYERS_APP_ID=YOUR_APP_ID-100
FYERS_SECRET_KEY=YOUR_SECRET_KEY
FYERS_REDIRECT_URI=https://yourdomain.com/api/broker/callback

# ═══════════════════════════════════════════════════════
# SECTION 5: WEBSOCKET TUNING
# ═══════════════════════════════════════════════════════

WS_PRICE_POLL_INTERVAL=0.1
WS_PORTFOLIO_REFRESH_INTERVAL=60.0

# ═══════════════════════════════════════════════════════
# SECTION 6: MAT ENGINE CONFIGURATION
# ═══════════════════════════════════════════════════════

MAT_CASH_BUFFER=0.01
MAT_BROKERAGE_RATE=0.3
MAT_STT_SELL_RATE=0.001
MAT_EXCHANGE_CHARGE_RATE=0.0000325
MAT_SEBI_CHARGE_RATE=0.000001
MAT_GST_RATE=0.18
MAT_STAMP_DUTY_BUY_RATE=0.00015
MAT_ORDER_WAIT_SECONDS=120
MAT_ORDER_POLL_INTERVAL_SECONDS=5
MAT_ORDER_MIN_INTERVAL_SECONDS=0.11
MAT_CANDIDATE_POOL_MULTIPLIER=1.5

# ═══════════════════════════════════════════════════════
# SECTION 7: LOGGING
# ═══════════════════════════════════════════════════════

LOG_LEVEL=INFO
LOG_DIR=logs
LOG_FILE_NAME=backend.log
REBALANCE_LOG_FILE_NAME=rebalancing.log
LOG_MAX_BYTES=5242880
LOG_BACKUP_COUNT=5

# ═══════════════════════════════════════════════════════
# SECTION 8: SCHEDULER
# ═══════════════════════════════════════════════════════

ENABLE_TESTING_ENDPOINTS=false
ENABLE_SCHEDULER=true
SCHEDULER_TIMEZONE=Asia/Kolkata

QUEUE_REBALANCE_HOUR_IST=9
QUEUE_REBALANCE_MINUTE_IST=0
DRAIN_REBALANCE_HOUR_IST=12
DRAIN_REBALANCE_MINUTE_IST=0
MARKET_OPEN_HOUR_IST=9
MARKET_OPEN_MINUTE_IST=15
MARKET_CLOSE_HOUR_IST=15
MARKET_CLOSE_MINUTE_IST=30

EOD_MTM_HOUR_IST=15
EOD_MTM_MINUTE_IST=40

RECONCILE_OPEN_HOUR_IST=9
RECONCILE_OPEN_MINUTE_IST=20

# ═══════════════════════════════════════════════════════
# SECTION 9: YAHOO FINANCE DATA SYNC
# ═══════════════════════════════════════════════════════

ENABLE_YAHOO_DAILY_SYNC=false
YAHOO_DAILY_SYNC_HOUR_IST=19
YAHOO_DAILY_SYNC_MINUTE_IST=0
YAHOO_REFERENCE_TICKER=NIFTYBEES.NS
YAHOO_BASE_DATE=2015-01-01
YAHOO_SPLIT_LOOKBACK_DAYS=5
YAHOO_VOLATILITY_WINDOW=252
YAHOO_ANNUALISE_VOL=false
YAHOO_API_DELAY_SECONDS=0.2
YAHOO_FETCH_RETRIES=3
YAHOO_FETCH_RETRY_DELAY_SECONDS=1.0
YAHOO_MAX_INTERNAL_GAP_DAYS=40
```

Save with `CTRL+O`, `Enter`, `CTRL+X`.

### 5.4 Docker Compose Database Credentials

The `docker-compose.yml` file contains the Postgres credentials that Docker uses to create the database:

```yaml
environment:
  POSTGRES_USER: postgres
  POSTGRES_PASSWORD: yourpassword    # ← Change this
  POSTGRES_DB: mat_system
```

**The password here must match exactly what you put in `DATABASE_URL` inside `backend/.env`.** If you change one, change both.

---

## 6. Build & Launch

### First-Time Launch
```bash
sudo docker compose up -d --build
```

This command:
1. Downloads PostgreSQL 15, Redis 7, Python 3.12, Node 20, and Nginx Alpine images
2. Creates the database with your credentials
3. Installs all Python packages (`requirements.txt`)
4. Compiles the React frontend with Vite
5. Configures Nginx as the reverse proxy
6. Boots all 4 containers on an isolated Docker network

### Initial Data Seeding
After the first launch (when the database is empty), you MUST seed the tickers and historical price data:
```bash
# 1. Ingest all tickers (fast)
sudo docker exec mat-backend python "data ingestion/ingest_tickers.py"

# 2. Ingest all historical price data (this takes a few minutes for 88MB CSV)
sudo docker exec mat-backend python "data ingestion/ingest_all.py"
```

### Verify Everything is Running
```bash
sudo docker ps
```

You should see 4 containers with status `Up`:
```
CONTAINER ID   IMAGE               STATUS                    NAMES
abc123...      mat-system-frontend  Up 2 minutes              mat-frontend
def456...      mat-system-backend   Up 2 minutes              mat-backend
ghi789...      redis:7-alpine       Up 2 minutes (healthy)    mat-redis
jkl012...      postgres:15-alpine   Up 2 minutes (healthy)    mat-db
```

### Quick Test
```bash
curl http://localhost
```
You should see HTML content from the React app.

---

## 7. Domain & HTTPS Setup (Cloudflare)

### 7.1 Why Cloudflare?
Cloudflare provides free, auto-renewing SSL certificates and DDoS protection without modifying any Docker configuration. Your Nginx listens on HTTP port 80, and Cloudflare wraps it in HTTPS for users.

```
User ──HTTPS:443──▶ Cloudflare ──HTTP:80──▶ Your Nginx Container
```

### 7.2 Setup Steps

1. **Buy a domain** (Namecheap, GoDaddy, etc.)
2. **Sign up at [cloudflare.com](https://cloudflare.com)** (free tier)
3. **Add your domain** to Cloudflare and update your registrar's nameservers to the ones Cloudflare provides
4. **Create an A Record** in Cloudflare DNS:
   - Type: `A`
   - Name: `@`
   - Content: Your server's public IP address
   - Proxy status: **Proxied** (Orange Cloud ON)
5. **Set SSL Mode**: Go to SSL/TLS → Overview → Select **"Flexible"**

### 7.3 Why "Flexible" SSL Mode?

| Mode | What it does | Works with our setup? |
|---|---|---|
| **Flexible** | Cloudflare → HTTP:80 → Your server | ✅ Yes |
| **Full** | Cloudflare → HTTPS:443 → Your server | ❌ No (Nginx has no SSL cert) |
| **Full (Strict)** | Same as Full but validates cert | ❌ No |

Your Nginx only listens on port 80 (HTTP). "Flexible" tells Cloudflare to talk to your origin over HTTP while still showing HTTPS to end users.

### 7.4 Update Backend `.env` After Domain Setup
```env
ALLOWED_HOSTS=127.0.0.1,yourdomain.com
FRONTEND_ORIGIN=https://yourdomain.com
FYERS_REDIRECT_URI=https://yourdomain.com/api/broker/callback
COOKIE_SECURE=true
```
Then restart:
```bash
sudo docker compose restart backend
```

---

## 8. Fyers Broker Configuration

After deploying, update your Fyers app settings at [myapi.fyers.in](https://myapi.fyers.in):

- **Redirect URL**: `https://yourdomain.com/api/broker/callback`

This must exactly match `FYERS_REDIRECT_URI` in your `backend/.env`.

---

## 9. Day-to-Day Operations

### View Live Backend Logs
```bash
sudo docker logs -f mat-backend
```
Press `CTRL+C` to stop watching.

### View Logs from Host Filesystem
Logs are persisted to the `./logs/` directory on your server:
```bash
tail -f logs/backend.log
tail -f logs/rebalancing.log
```

### Check Container Health
```bash
sudo docker ps
sudo docker stats          # Live CPU/RAM usage
```

### Restart a Single Container
```bash
sudo docker compose restart backend    # After .env changes
sudo docker compose restart frontend   # After nginx.conf changes
```

### Stop Everything
```bash
sudo docker compose down
```

### Stop and Delete All Data (Nuclear Option)
```bash
sudo docker compose down -v    # -v deletes the database volume!
```

---

## 10. Updating the Application

When you push new code to GitHub:

```bash
# On the server
cd ~/MAT-System
git pull origin main

# Rebuild only what changed
sudo docker compose up -d --build
```

Docker intelligently caches unchanged layers. If you only changed Python code, only the backend rebuilds (~15s). If you changed React code, only the frontend rebuilds (~30s).

### When to Use `--no-cache`
Force a complete rebuild if cached layers cause issues:
```bash
sudo docker compose build --no-cache
sudo docker compose up -d
```

### When You Only Changed `.env` Variables
No rebuild needed. Just restart:
```bash
sudo docker compose restart backend
```

> **Exception:** If you change `frontend/.env` (`VITE_API_BASE_URL`), you MUST rebuild the frontend because Vite bakes the value into JavaScript at compile time:
> ```bash
> sudo docker compose build --no-cache frontend
> sudo docker compose up -d frontend
> ```

---

## 11. Troubleshooting

### "This site can't be reached" / Connection Timeout
- **Firewall not open.** See [Section 3.2](#32-firewall-configuration). On Oracle Cloud, you must open ports in BOTH the cloud dashboard AND the server terminal.
- **Docker not running.** Run `sudo docker ps` to verify containers are up.

### Cloudflare Error 523 (Origin Unreachable)
- Cloudflare can't reach your server on the expected port.
- Verify firewall rules allow port 80.
- Verify Cloudflare SSL mode is set to **"Flexible"**, not "Full".

### Nginx 405 Method Not Allowed
- Frontend is hitting the wrong URL for API calls.
- Ensure `frontend/.env` contains `VITE_API_BASE_URL=/api` (relative, not absolute).
- Ensure `frontend/.dockerignore` does NOT exclude `.env` files.
- Rebuild frontend with `--no-cache`.

### CORS Errors in Browser Console
- `FRONTEND_ORIGIN` in `backend/.env` doesn't match the actual domain.
- If using HTTPS (Cloudflare), origin must be `https://yourdomain.com`, not `http://`.

### Login Loop / Cookie Not Setting
- `COOKIE_SECURE=true` but accessing via `http://`.
- Either use HTTPS (Cloudflare) or set `COOKIE_SECURE=false` for local testing.

### "permission denied" When Running Docker
```bash
sudo usermod -aG docker $USER
newgrp docker
```
Or prefix all commands with `sudo`.

### Backend Crashes on Startup
Check the logs:
```bash
sudo docker logs mat-backend
```
Common causes:
- Missing `.env` variables → backend crashes with `ValidationError`
- Wrong `DATABASE_URL` → cannot connect to `db` container
- Typo in `REDIS_URL` → cannot connect to `redis` container

### Database Connection Refused
- Ensure `DATABASE_URL` uses `db:5432` (not `localhost:5432`)
- Ensure the password matches `POSTGRES_PASSWORD` in `docker-compose.yml`

---

## 12. FAQ

### Do I need to install Python, Node.js, Nginx, PostgreSQL, or Redis on my server?
**No.** Docker downloads and manages all of them automatically inside isolated containers. The only software you install on your server is Docker itself.

### Where do I get the Postgres username and password?
**You make them up!** Docker creates a brand-new, empty database from scratch. You decide the credentials in `docker-compose.yml` and match them in `backend/.env`.

### Is my database exposed to the internet?
**No.** PostgreSQL and Redis have no `ports:` mapping in `docker-compose.yml`. They exist only on Docker's internal network. The only container reachable from the internet is the Nginx frontend on port 80.

### What happens to my data if I restart Docker?
**Nothing — it's safe.** PostgreSQL data is stored on a persistent Docker volume (`mat_pgdata`). It survives container restarts, rebuilds, and server reboots.

### What happens to my data if I run `docker compose down`?
**Still safe.** `down` stops and removes containers but preserves volumes. Only `docker compose down -v` deletes the volume (and your data).

### Do I need to change `docker-compose.yml` when switching domains?
**No.** Only change `backend/.env` and restart. The Docker infrastructure is domain-agnostic.

### Do I need to rebuild when I change `backend/.env`?
**No.** Backend `.env` is read at runtime. Just restart:
```bash
sudo docker compose restart backend
```

### Do I need to rebuild when I change `frontend/.env`?
**Yes.** Vite bakes environment variables into JavaScript at compile time:
```bash
sudo docker compose build --no-cache frontend
sudo docker compose up -d frontend
```

### Can I run this on my local Windows PC?
**Yes**, using Docker Desktop for Windows. Use `COOKIE_SECURE=false` and access via `http://localhost`. However, your home router blocks external access — you'd need port forwarding to reach it from the internet.

### How do I get HTTPS without Cloudflare?
You would need to add a Certbot container to Docker Compose, mount SSL certificates into Nginx, and configure `nginx.conf` to listen on port 443. Certificates expire every 90 days and need auto-renewal. Cloudflare is significantly simpler.

### How much does deployment cost?
- **Oracle Cloud**: Free forever (Always Free tier)
- **Domain**: ~₹800/year (Namecheap)
- **Cloudflare**: Free
- **Total**: ~₹800/year

---

## Quick Reference Card

| Task | Command |
|---|---|
| First-time build & start | `sudo docker compose up -d --build` |
| View running containers | `sudo docker ps` |
| View backend logs (live) | `sudo docker logs -f mat-backend` |
| Restart after `.env` change | `sudo docker compose restart backend` |
| Pull & deploy new code | `git pull && sudo docker compose up -d --build` |
| Full rebuild (no cache) | `sudo docker compose build --no-cache && sudo docker compose up -d` |
| Stop all containers | `sudo docker compose down` |
| Stop & wipe database | `sudo docker compose down -v` |
