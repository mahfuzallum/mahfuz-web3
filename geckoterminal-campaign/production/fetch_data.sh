#!/usr/bin/env bash
# Re-capture the GeckoTerminal snapshot used by the film (public API, ~30 req/min limit).
set -euo pipefail
cd "$(dirname "$0")/data"
B=https://api.geckoterminal.com/api/v2; H="Accept: application/json"
NET=solana; POOL=Fe7bpDYCs74GqiCUF14HwgUMToPKV1d9mDYVX5BTohFr; TOKEN=2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM
g(){ curl -sf "$B/$1" -H "$H" > "$2"; sleep 2.2; }
date -u +%Y-%m-%dT%H:%M:%SZ > capture_time.txt
for d in 1h 6h 24h; do g "networks/trending_pools?page=1&duration=$d&include=base_token,dex,network" trending_$d.json; done
g "networks/new_pools?page=1&include=base_token,network,dex" new_pools.json
g "networks/$NET/pools/$POOL?include=base_token,quote_token,dex" claudia_pool.json
g "networks/$NET/pools/$POOL/ohlcv/hour?aggregate=1&limit=72&currency=usd" claudia_ohlcv_1h.json
g "networks/$NET/pools/$POOL/ohlcv/minute?aggregate=15&limit=96&currency=usd" claudia_ohlcv_15m.json
g "networks/$NET/pools/$POOL/ohlcv/day?aggregate=1&limit=60&currency=usd" claudia_ohlcv_1d.json
g "networks/$NET/pools/$POOL/trades" claudia_trades.json
g "networks/$NET/tokens/$TOKEN/info" claudia_info.json
echo "Captured at $(cat capture_time.txt). Rebuild web/data.js, then re-render."
