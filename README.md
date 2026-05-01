# TP3 · XAU/USD Trading Terminal

Stack: Next.js App Router · TypeScript · Supabase · Binance Futures WS

---

## Directory structure

```
tp3/
├── app/
│   ├── page.tsx                     ← Server component, passes userId to LiveTerminal
│   └── api/
│       ├── backtest/route.ts        ← POST — runs engine server-side
│       ├── operations/route.ts      ← GET/POST/PATCH — Supabase server-side only
│       ├── klines/route.ts          ← Binance proxy (avoids CORS in prod)
│       └── agent/route.ts           ← AI agent stub (Claude / OpenAI)
│
├── components/
│   └── LiveTerminal.tsx             ← Main terminal UI
│
├── lib/
│   ├── engine/                      ← PURE MATH — zero deps, zero framework
│   │   ├── types.ts
│   │   ├── indicators.ts            ← emaCalc, rsiCalc, bollCalc, precompute
│   │   ├── signals.ts               ← detectSignals, htfSignal, mtfSignal
│   │   └── simulator.ts             ← simulateSignals, summarize, calcEV
│   │
│   ├── agent/                       ← AI tools (activate when ready)
│   │   └── tools/run_backtest.ts
│   │
│   ├── db/supabase.ts               ← SERVER-ONLY Supabase client
│   └── ws/binance-ws.ts             ← useWebSocket hook
│
└── .env.local.example
```

---

## Setup

```bash
cp .env.local.example .env.local
# Fill in SUPABASE_URL and SUPABASE_SERVICE_KEY

npm install
npm run dev
```

---

## Key architectural decisions

### 1. Engine is pure
`lib/engine/` has zero imports from React, Next.js, or any database.
This means:
- You can test the math with `bun test` in milliseconds
- The AI agent can call `detectSignals()` directly without a network request
- You can swap the UI without touching the calculation

### 2. Supabase only on the server
`lib/db/supabase.ts` uses the **service role key** and is only imported in API routes.
The browser never has direct database access. `LiveTerminal.tsx` calls `/api/operations`.

### 3. AI agent is a stub
`app/api/agent/route.ts` returns a 501 today. When you're ready:
- Uncomment the Anthropic section and set `ANTHROPIC_API_KEY`
- The tools in `lib/agent/tools/` already call the engine directly
- The system prompt in the route already uses the market snapshot

### 4. WebSocket reconnects automatically
`lib/ws/binance-ws.ts` reconnects after 3s on drop. The `LIVE` badge in the topbar
reflects connection state. WebSocket closes cleanly on component unmount.

---

## Connecting the AI agent

```bash
# 1. Set your key
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env.local

# 2. Uncomment Option A in app/api/agent/route.ts
# 3. POST to /api/agent with { messages, snapshot }
```

The `MarketSnapshot` type in `lib/engine/types.ts` defines exactly what context
the agent receives. Add more fields there as you instrument the system.
