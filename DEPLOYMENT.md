# MAT System Deployment Guide (Updated)

This document is the canonical, end-to-end deployment runbook for the current MAT stack.
It includes everything implemented in the latest setup:

- Dockerized frontend, backend, postgres, redis, and Evolution API
- Cloudflare DNS and TLS with Full (strict)
- HTTPS enabled on origin (Nginx in frontend container, ports 80 and 443)
- Dedicated Evolution Manager host: manager.example.com
- Backend WhatsApp integration through Evolution API
- Rebalance queue and completion notifications with detailed leg summaries

---

## 1. Current Architecture

Internet traffic reaches only the frontend Nginx container.
All other services are private on the Docker network.

- Public hosts:
- https://_ -> React app + /api reverse proxy
- https://manager.example.com/manager/ -> Evolution Manager UI

- Internal services:
- backend:8000 (FastAPI)
- evolution-api:8080 (Evolution API)
- db:5432 (Postgres)
- redis:6379 (Redis)

---

## 2. Prerequisites

Install on server:

1. Docker Engine
2. Docker Compose v2

Optional:

1. Git
2. curl

Verify:

```bash
docker --version
docker compose version
```

---

## 3. Clone Project

```bash
git clone https://github.com/php2k6/MAT-System.git
cd MAT-System
```

---

## 4. Environment Files

Use these files only:

1. backend/.env
2. frontend/.env

Do not use root-level .env files for this deployment.

### 4.1 frontend/.env

```env
VITE_API_BASE_URL=/api
```

### 4.2 backend/.env (minimum required)

```env
# Core
DATABASE_URL=postgresql+psycopg2://postgres:yourpassword@db:5432/mat_system
REDIS_URL=redis://redis:6379/0

# Hosts and CORS
ALLOWED_HOSTS=_,manager.example.com,localhost,127.0.0.1
FRONTEND_ORIGIN=https://_
COOKIE_SECURE=true

# Auth
JWT_SECRET_KEY=replace_with_long_random_secret
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=10080

# Fyers
FYERS_APP_ID=YOUR_APP_ID-100
FYERS_SECRET_KEY=YOUR_SECRET
FYERS_REDIRECT_URI=https://_/api/broker/callback

# Evolution API
EVOLUTION_API_URL=http://evolution-api:8080
EVOLUTION_API_KEY=replace_with_evolution_global_api_key
EVOLUTION_API_INSTANCE=mat-system

# Testing utility endpoint
ENABLE_TESTING_ENDPOINTS=true
```

Important:

1. DATABASE_URL password must match docker-compose postgres password.
2. EVOLUTION_API_KEY must match Evolution AUTHENTICATION_API_KEY.
3. EVOLUTION_API_INSTANCE must match the instance name created in Manager.

---

## 5. TLS Certificates on Origin (Cloudflare Origin Cert)

Origin TLS is enabled in frontend Nginx container.
Certificates are mounted from frontend/certs.

### 5.1 Create cert in Cloudflare

Cloudflare -> SSL/TLS -> Origin Server -> Create certificate

Use hostnames:

1. phpx.live
2. *.phpx.live

Download:

1. certificate
2. private key

### 5.2 Save cert files in project

Create files:

1. frontend/certs/origin.crt
2. frontend/certs/origin.key

These are ignored by git via frontend/.gitignore.

---

## 6. DNS and Cloudflare Settings

### 6.1 DNS records

In Cloudflare DNS:

1. A record: trade -> <your-server-ip> (Proxied ON)
2. A record: manager -> <your-server-ip> (Proxied ON)

Note:

- manager means manager.example.com
- manager.trade means manager._

If you want manager.example.com, record name must be manager.

### 6.2 SSL mode

Set Cloudflare SSL/TLS mode to Full (strict).
Do not use Flexible for this setup.

---

## 7. Nginx and Compose (already aligned)

Current setup expects:

1. frontend/nginx.conf with
- HTTP to HTTPS redirects for _ and manager.example.com
- 443 SSL servers using /etc/nginx/certs/origin.crt and origin.key
- /api and docs proxy to backend
- /evolution proxy to evolution-api
- /manager redirect on trade host to manager host
- manager host reverse proxy to evolution-api

2. docker-compose.yml frontend service with
- ports 80:80 and 443:443
- mount frontend/nginx.conf to /etc/nginx/conf.d/default.conf
- mount frontend/certs to /etc/nginx/certs

---

## 8. Build and Start

```bash
docker compose up -d --build
```

Check:

```bash
docker compose ps
```

Expected running containers:

1. mat-frontend
2. mat-backend
3. evolution-api
4. mat-db
5. mat-redis

---

## 9. Evolution Manager Setup

Open:

1. https://manager.example.com/manager/

Login inputs:

1. Server URL: https://manager.example.com
2. Global API Key: AUTHENTICATION_API_KEY from evolution-api container config

Then:

1. Create instance named mat-system (or update backend EVOLUTION_API_INSTANCE accordingly)
2. Connect WhatsApp by scanning QR
3. Wait for connected status

---

## 10. WhatsApp Integration Behavior (Current)

Backend sends via Evolution using:

1. Instance-aware sendText route
2. Payload with number and text
3. Number normalized to digits

Number format to save in profile:

1. +919876543210

No spaces, no dashes.

Test path:

1. Profile page -> save WhatsApp -> send test
2. API endpoint: POST /api/auth/testing/whatsapp

---

## 11. Rebalance Notifications Included

Scheduler now sends rich formatted WhatsApp notifications for:

1. Queue created (scheduled)
2. Retry reminder for skipped queue rows
3. Completion outcome (done/skipped/failed)

Completion message includes:

1. Strategy and queue identifiers
2. Completion time and reason
3. Capital snapshot (before and after)
4. Leg summary counts (filled, partial, failed)
5. SELL and BUY leg lines with qty, remaining qty, status, and errors

---

## 12. Fyers Configuration

In Fyers app settings, set redirect URL exactly:

1. https://_/api/broker/callback

Must match backend/.env value FYERS_REDIRECT_URI.

---

## 13. Initial Data Seeding

Run once after first clean deployment:

```bash
docker exec mat-backend python "data ingestion/ingest_tickers.py"
docker exec mat-backend python "data ingestion/ingest_all.py"
```

---

## 14. Day-2 Operations

### Logs

```bash
docker compose logs -f backend
docker compose logs -f evolution-api
docker compose logs -f frontend
```

### Restart after env/config changes

```bash
docker compose restart backend
docker compose restart frontend
docker compose restart evolution-api
```

### Pull and deploy updates

```bash
git pull origin main
docker compose up -d --build
```

---

## 15. Troubleshooting

### 15.1 Certificate error for manager host

Symptom:

- This hostname is not covered by a certificate

Fix:

1. Ensure DNS record is manager (not manager.trade) when using manager.example.com
2. Keep proxy ON
3. Ensure Cloudflare mode is Full (strict)
4. Ensure origin cert includes *.phpx.live
5. Wait for edge cert propagation

### 15.2 Manager blank page

Fix in current architecture:

1. Use dedicated host manager.example.com
2. Do not serve manager UI under same asset namespace as React app

### 15.3 Backend error: Settings has no attribute EVOLUTION_API_URL

Cause:

- Code referenced uppercase settings fields

Status:

- Fixed to use lowercase settings model fields

### 15.4 Evolution 404 Cannot POST /message/sendText

Cause:

- Wrong route/payload style

Status:

- Fixed to instance-aware sendText behavior with normalized number

### 15.5 Frontend shows Bad Gateway on WhatsApp test

Cause:

- Backend returns 502 when Evolution call fails

Check:

```bash
docker compose logs --tail=200 backend evolution-api
```

### 15.6 Flexible SSL confusion

Guidance:

- Flexible is not recommended here.
- Use Full (strict) since origin HTTPS is enabled.

---

## 16. Quick Validation Checklist

1. https://_ loads app
2. https://manager.example.com/manager/ loads Evolution Manager
3. Broker callback URL matches Fyers app
4. Profile save WhatsApp works
5. Test WhatsApp sends successfully
6. Queue and completion notifications arrive with formatted details

---

## 17. Command Reference

```bash
# Start/rebuild
docker compose up -d --build

# Validate compose
docker compose config

# Service status
docker compose ps

# Logs
docker compose logs -f backend
docker compose logs -f evolution-api
docker compose logs -f frontend

# Restart selected services
docker compose restart backend frontend evolution-api

# Stop
docker compose down

# Stop and remove volumes (destructive)
docker compose down -v
```
