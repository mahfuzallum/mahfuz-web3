# GeckoTerminal Watchlist Campaign: Research Dossier & Production Notes

**Film:** "Signal, Not Noise". 16:9, 3840×2160, 30 fps, 96 s, English male narration, original electronic score. 1080p cut: `video/GeckoTerminal_Watchlist_Campaign_1080p.mp4` (the 4K master is delivered separately; it exceeds GitHub's 100 MB file limit).
**Data capture window:** 22 Nov 2026, 02:09–02:11 UTC (GeckoTerminal public API `api.geckoterminal.com/api/v2`).
**Status of figures:** every on-screen market figure comes from that snapshot. Figures change in real time, so re-capture before publishing if the video goes out later. Re-capture means re-running `production/` (see the end of this file).

> Educational demonstration only. Not investment advice, not a recommendation, no price prediction.

---

## 1. What could and could not be captured

| Requirement | Result |
|---|---|
| Live market data (trending pools, new pools, pool detail, OHLCV, trades, token info / GT Score) | ✅ Pulled live from the official GeckoTerminal API |
| Website screenshots / screen recordings of geckoterminal.com | ❌ **Not captured.** The site sits behind a Cloudflare bot check that blocks automated browsers from this cloud environment. I did not bypass it. |
| Official mobile app visuals | ✅ The 4 official screenshots and the app icon from the GeckoTerminal Google Play listing ("GeckoTerminal: DEX Tracker", `com.geckoterminal.www.twa`) |
| Your personal Watchlist | ❌ No link or screenshot was supplied. The film does **not** pretend a list is yours. The Watchlist scene is labelled on screen as an illustrative layout built from the snapshot. |

**Recommended finishing step (10 minutes, on your own computer):** record the 6 shots in the [shot list](#6-shot-list-for-real-screen-recordings) and drop them over the matching timecodes. The film is built so each data scene has a direct website counterpart.

---

## 2. Platform facts verified

| Claim | Status | Source |
|---|---|---|
| Built by the team behind CoinGecko | ✅ Verified | Google Play listing: "built by the team behind CoinGecko" |
| Multiple watchlists | ✅ Verified | Play listing: "Create your own watchlist … or customize multiple watchlists" |
| Trending Pools, New Pools, DEX & Chain rankings | ✅ Verified | Play listing sections; API endpoints |
| Price alerts, holder insights in the app | ✅ Verified | Official store screenshots |
| **200+ networks** | ✅ Verified | Public API `/networks` returned **222** networks on 22 Nov 2026; store screenshot says "200+ Chains" |
| **50M+ token prices** | ⚠️ Campaign-provided, not independently verified | The Play listing text still says "2M+ cryptocurrencies across 100+ chains" (older copy) |
| **2,000+ DEXes** | ⚠️ Campaign-provided, not independently verified | Not stated on any page reachable from this environment |

The film shows 50M+ / 200+ / 2,000+ with an on-screen footnote: "Coverage figures as provided in the campaign brief. GeckoTerminal public API listed 222 networks on 22 Nov 2026."

---

## 3. Token selection: 20 trending pools compared (24h, all networks)

| # | Pool | Network · DEX | Liquidity | 24h Vol | Vol/Liq | 24h Txns (B/S) | 24h Δ | Pool created |
|---|---|---|---:|---:|---:|---:|---:|---|
| 1 | DCTY / ETH | eth · Uniswap V4 | $148,062 | $3,520,821 | 23.8× | 2,377/833 | -37.2% | 2026-11-19 |
| 2 | FIONA / ETH | eth · Uniswap V4 | $154,098 | $835,132 | 5.4× | 1,238/1,005 | +123.4% | 2026-11-20 |
| 3 | WASTED / ETH | eth · Uniswap V4 | $340,353 | $925,505 | 2.7× | 1,042/395 | +6.6% | 2026-11-18 |
| 4 | SI / WBNB | bsc · PancakeSwap V2 | $102,186 | $72,822 | 0.7× | 7,601/901 | +71.6% | 2026-10-18 |
| 5 | CASHCAT / WETH | robinhood · Uniswap V3 | $608,311 | $1,174,015 | 1.9× | 2,561/2,561 | +4.0% | 2026-07-01 |
| 6 | 蚂蚁 / ANTB | bsc · PancakeSwap V2 | $24,283 | $586,663 | 24.2× | 45,289/3,201 | -92.3% | 2026-11-20 |
| 7 | HOOKR / WETH | robinhood · Pools.trade | $618,450 | $971,891 | 1.6× | 1,463/1,859 | -15.1% | 2026-08-06 |
| **8** | **CLAUDIA / SOL** | **solana · PumpSwap** | **$449,561** | **$3,029,805** | **6.7×** | **14,472/13,159** | **+57.5%** | **2026-10-07** |
| 9 | DCTY / TTWO | solana · PumpSwap | $294,916 | $2,400,811 | 8.1× | 11,321/10,629 | +120.6% | 2026-10-20 |
| 10 | EVAA / USDT | bsc · PancakeSwap V3 | $334,090 | $2,881,727 | 8.6× | 28,394/32,528 | -7.0% | 2025-10-02 |
| 11 | Singularity / SOL | solana · PumpSwap | $57,662 | $2,655,283 | 46.0× | 28,472/20,608 | +253.4% | 2026-11-20 |
| 12 | FIONA / SOL | solana · PumpSwap | $139,677 | $3,380,495 | 24.2× | 24,950/21,046 | +115.6% | 2026-11-19 |
| 13 | NVDAc / USDC | base · Aero Slipstream | $1,388,355 | $15,273,027 | 11.0× | 8,368/7,460 | +0.2% | 2026-10-22 |
| 14 | PONS / USDG | robinhood · Ramses V3 | $233,804 | $815,800 | 3.5× | 4,000/3,836 | -4.9% | 2026-08-11 |
| 15 | mihao / SOL | solana · PumpSwap | $335,249 | $1,512,905 | 4.5× | 9,598/6,871 | +20.5% | 2026-10-25 |
| 16 | DRV / USDC | base · Uniswap V4 | $2,814,812 | $1,789,367 | 0.6× | 2,463/1,542 | +34.5% | 2026-05-26 |
| 17 | PUMP / USDC | solana · PumpSwap | $17,331,174 | $3,755,173 | 0.2× | 5,266/4,694 | -3.8% | 2025-07-14 |
| 18 | PONS / WETH | robinhood · Uniswap V3 | $1,114,674 | $143,961 | 0.1× | 879/405 | -3.4% | 2026-07-13 |
| 19 | AKE / WBNB | bsc · PancakeSwap V3 | $1,071,224 | $39,129,379 | 36.5× | 57,105/65,400 | -27.4% | 2025-08-20 |
| 20 | PEPE / WETH | eth · Uniswap V2 | $22,792,201 | $1,292,662 | 0.1× | 274/378 | -1.4% | 2023-04-14 |

(Trending-list values at 02:09 UTC. The pool-detail values used in the analysis below were fetched at 02:10 UTC, so CLAUDIA's 24h change reads +57.5% here and +59.2% below.)

**Shortlist and decision**

- **Excluded as suspicious or unsuitable:** 蚂蚁/ANTB (−92%, 45k buys vs 3.2k sells on $24k liquidity, a bot-like pattern), Singularity/SOL (46× turnover on $58k liquidity, 2 days old), DCTY/ETH and FIONA/SOL (≥ 24× turnover, pools under 3 days old).
- **Very liquid but little to teach:** PUMP/USDC, PEPE/WETH (deep liquidity, flat price).
- **No token security data available:** DRV, NVDAc, WASTED, CASHCAT (the API returned no GT Score or holder data).
- **Selected: CLAUDIA / SOL (PumpSwap, Solana).** It has sufficient liquidity ($450k, reported 100% locked), a 46-day-old pool, broad participation (5,287 unique traders in 24h) and a full GT Score breakdown with holder data. Its numbers also tell a mixed story, which makes it a balanced teaching case rather than a success story.
- **Used as the cautionary contrast:** AKE / WBNB. Its 24h volume was 36.5× its liquidity while the price fell 27%.

---

## 4. CLAUDIA / SOL: the analysis behind the film

Pool `Fe7bpDYCs74GqiCUF14HwgUMToPKV1d9mDYVX5BTohFr` · token `2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM`

**A. Price action** (02:10 UTC)
- Price **$0.009968** · FDV **$9.43M**
- 5m **−1.47%** · 1h **+6.06%** · 6h **−18.53%** · 24h **+59.18%**
- From the hourly candles: 24h high **$0.012907** (21 Nov, 20:00 UTC hour) and a 24h low near **$0.0056**. At snapshot time the price sat about 23% below the 24h high.
- *Observation:* the 24h move is strongly positive, but the most recent 6 hours pulled back sharply from the peak. The timeframe you choose changes the story.

**B. Trading activity** (24h)
- Volume **$3.03M**
- **14,489 buys vs 13,161 sells** (52.4% / 47.6%)
- **3,616 unique buyers vs 3,673 unique sellers** (49.6% / 50.4%)
- 5,287 unique traders
- *Interpretation:* buy transactions outnumbered sells, but slightly more wallets sold than bought. Transaction counts alone overstate one-sided demand.
- In the last hour, sells (495) and sellers (260) both exceeded buys (439) and buyers (215).

**C. Liquidity**
- **$450.6K** liquidity, reported **100% locked**
- 24h volume ÷ liquidity = **6.7×**
- *Interpretation:* that is intense turnover. It is far below the 24–46× outliers in the list, but it still means the pool's depth was traded several times over. Heavy turnover means activity, not proof of demand.

**D. Pool information**
- Solana · PumpSwap · CLAUDIA / SOL
- Pool created **7 Oct 2026** (46 days old at capture)
- Token info: "Claudia is an AI influencer character and a platform built around that character on Solana" (GeckoTerminal token description)

**E. Security indicators** (GeckoTerminal token info, 02:09 UTC)
- **GT Score 88.9 / 100.** Pool 77.1 · Transactions 100 · Creation 100 · Info 100 · Holders 93.8
- Mint authority: **disabled** · Freeze authority: **disabled** · Honeypot: *unknown* (not shown in the film)
- Holders **14,111** (holder data last updated 21 Nov 2026, 05:01 UTC)
- Top 10 holders hold **18.6%**
- *Interpretation:* these are positive structural signals, but they are context, not a safety guarantee. A memecoin with this volatility profile remains high-risk.

---

## 5. Narration script (as recorded)

| # | Scene | Time | Narration |
|---|---|---|---|
| 1 | Hook: live New Pools feed | 0:00 | In the last thirty seconds, twenty new liquidity pools opened on-chain. Each one… a new chart. |
| 2 | Problem | 0:08 | Chase them all, and research turns into noise. |
| 3 | Platform | 0:12 | GeckoTerminal, from the team behind CoinGecko, tracks on-chain markets in real time. Prices, pools, trades and liquidity, across more than two hundred networks. |
| 4 | Method: 20-pool scatter | 0:24 | So, a real example. We compared twenty trending pools, and chose one to study. |
| 5 | Price across timeframes | 0:30 | Claudia, on Solana. Up fifty-nine percent in twenty-four hours. Yet down eighteen, over six. Same pool. Two stories. |
| 6 | Volume vs liquidity | 0:39 | Three million dollars traded, against four hundred and fifty thousand in liquidity. Intense activity. Not, by itself, strength. |
| 7 | Wallets vs clicks | 0:49 | More buy transactions than sells. But buyers and sellers? Almost exactly even. Count wallets, not clicks. |
| 8 | Safety signals | 0:57 | GT Score, eighty-nine. Mint and freeze authority, disabled. Useful context. Never a guarantee. |
| 9 | **Watchlist** | 1:06 | But one look is just a snapshot. Research is a routine. Add the pool to your Watchlist. Build lists for the narratives you follow. And start each day with one question. What changed? |
| 10 | Mobile | 1:19 | Away from your desk, the GeckoTerminal app keeps those markets close. |
| 11 | CTA | 1:24 | Stop checking random charts. Build your own on-chain research routine. |
| 12 | End card | 1:30 | (music) GeckoTerminal · MY WATCHLIST. MY MARKETS. MY RESEARCH. · www.geckoterminal.com · disclaimer |

**Fact check of the hook:** the New Pools feed showed 20 pools created between 02:10:16 and 02:10:44 UTC, a 28-second window.

---

## 6. Shot list for real screen recordings

Record at 3840×2160 (or 2560×1440), dark theme, 30 fps, cursor slow and deliberate. Each shot replaces or overlays the matching scene.

| # | Replace scene at | What to record on geckoterminal.com |
|---|---|---|
| S1 | 0:00–0:08 | **New Pools** page (all networks), with the list updating live |
| S2 | 0:12–0:24 | Homepage: hover over the Trending bar, then Categories and network chips |
| S3 | 0:24–0:30 | **Trending Pools** (24h); sort by Liquidity, then by Volume |
| S4 | 0:30–0:57 | CLAUDIA/SOL pool page: toggle the 5m / 1h / 6h / 24h stats, scroll through the chart, trades table and buyer/seller counts |
| S5 | 0:57–1:06 | Same pool: the GT Score panel and the holders / security section |
| S6 | 1:06–1:19 | **Your Watchlist:** click ☆ on the pool, open the Watchlist page, create a second list (e.g. "AI narrative"), and show your real list. Add your Watchlist link to the end card. |
| S7 | 1:19–1:24 | GeckoTerminal app on your phone: the Watchlist tab and a price alert |

Remember: if you record later, the numbers on screen will differ from the 22 Nov snapshot. Either re-run the data pipeline so both match, or keep recordings to interface and navigation.

---

## 7. Production stack (all original, all reproducible)

- **Data:** GeckoTerminal public API (`trending_pools`, `new_pools`, `pools/{addr}`, `ohlcv`, `trades`, `tokens/{addr}/info`, `networks`)
- **Visuals:** a custom HTML canvas renderer that draws every chart and number from `data.js`, rendered frame by frame in headless Chromium at 3840×2160
- **Voiceover:** Kokoro-82M neural TTS (open-weights, Apache-2.0), with a blended `am_michael` and `am_fenrir` American male voice
- **Music:** an original score synthesised in Python/NumPy. D-minor progression, detuned pads, sidechained sub-bass pulse, arpeggio from 0:24, hi-hats from 0:39, riser into the CTA, impact on the logo. No samples or licensed tracks.
- **Mix:** narration ducks the music automatically; the final mix is loudness-normalised to −14 LUFS integrated, −1 dBTP
- **Brand assets:** the app icon and screenshots are taken unmodified from the official Google Play listing. The wordmark is typeset in Space Grotesk; swap in the official logo file if the campaign provides one.
