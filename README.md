# TrendShopX GameFi

V1 full-stack space strategy/GameFi foundation. Original implementation; it does not copy Xnova/OGame source code or assets.

## Stack
React + TypeScript + Vite / Express + TypeScript / Prisma + PostgreSQL / WebSocket-ready API / Docker.

## Modules
Auth, planet economy, buildings, missions, fleets, battles, alliances-ready schema, P2P market, internal TSX/USDT wallet, ledger, rankings, admin stats.

## Quick start
1. cp .env.example .env
2. docker compose up -d postgres
3. npm install
4. npm run db:push
5. npm run dev

Web: http://localhost:5173
API: http://localhost:4000/health

## Web3
The V1 wallet is custodial-free at the application level: no seed phrases/private keys are stored. Blockchain deposits/withdrawals must be implemented behind a provider adapter and verified on-chain before enabling production value transfers.
