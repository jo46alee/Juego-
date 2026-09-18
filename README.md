# TrendShopX GameFi V4

Original space-strategy/GameFi project for TrendShopX. V4 extends the V3 foundation with a deeper economy, fleets, defenses, expeditions, seasonal progression, referrals and an order-book market. It does not copy Xnova/OGame source code, assets or proprietary content.

## V4 modules
- Planet economy and production ticks
- Build/research/ship queues
- Hangar and planetary defenses
- Fleet creation, cargo, destinations and travel lifecycle
- Expedition events and rewards
- Advanced battle simulation with ship losses and defensive units
- Seasonal ranking points
- Referral codes and rewards
- TSX/USDT order book with locked balances and 3% configurable fee
- Internal ledger and audit-ready structure
- WebSocket notifications/chat foundation
- Simulated Web3 deposits/withdrawals only

## Stack
React + TypeScript + Vite / Express + TypeScript / Prisma + PostgreSQL / WebSocket / Docker.

## Start
1. cp .env.example .env
2. docker compose up -d postgres
3. npm install
4. npm run db:generate
5. npm run db:push
6. npm run dev

Web: http://localhost:5173
API: http://localhost:4000/health

## Production safety
The Web3 endpoints are simulation-only. Do not enable real-value deposits/withdrawals until an audited provider/RPC adapter, chain confirmations, replay protection, limits, monitoring and operational controls are implemented. Never store seed phrases or private keys.

## V4 API highlights
- GET /v4/status
- GET/POST /defenses, /defenses/build
- POST /fleets, /fleets/dispatch, /fleets/arrive
- GET/POST /expeditions, /expeditions/start
- GET /seasons, POST /admin/seasons
- GET /referrals, POST /referrals/activate
- GET /market, POST /market/orders, POST /market/orders/:id/fill, POST /market/orders/:id/cancel
- GET /notifications
- GET /admin/stats
