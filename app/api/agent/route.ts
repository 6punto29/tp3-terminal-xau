// ─────────────────────────────────────────────────────────────────────────────
// app/api/agent/route.ts
// POST /api/agent
// Body: { messages: CoreMessage[], snapshot?: MarketSnapshot }
//
// AI agent endpoint. Stub is functional as-is — returns a 501 with clear
// instructions for connecting Claude or OpenAI.
// To activate: uncomment one of the sections below and set the API key env var.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { MarketSnapshot } from "@/lib/engine/types";

// ── Payload types ─────────────────────────────────────────────────────────────

interface AgentRequest {
  messages:  { role: "user" | "assistant"; content: string }[];
  snapshot?: MarketSnapshot;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { messages, snapshot } = (await req.json()) as AgentRequest;

  if (!messages?.length)
    return NextResponse.json({ error: "messages required" }, { status: 400 });

  // ────────────────────────────────────────────────────────────────────────────
  // OPTION A: Anthropic Claude  (uncomment + set ANTHROPIC_API_KEY)
  // ────────────────────────────────────────────────────────────────────────────
  // import Anthropic from "@anthropic-ai/sdk";
  // const client = new Anthropic();
  //
  // const systemPrompt = buildSystemPrompt(snapshot);
  // const response = await client.messages.create({
  //   model:      "claude-opus-4-5",
  //   max_tokens: 1024,
  //   system:     systemPrompt,
  //   messages,
  //   tools: [
  //     { name: "run_backtest",    ... },
  //     { name: "save_operation",  ... },
  //   ],
  // });
  // return NextResponse.json({ content: response.content });

  // ────────────────────────────────────────────────────────────────────────────
  // OPTION B: OpenAI  (uncomment + set OPENAI_API_KEY)
  // ────────────────────────────────────────────────────────────────────────────
  // import OpenAI from "openai";
  // const openai = new OpenAI();
  // const completion = await openai.chat.completions.create({
  //   model:    "gpt-4o",
  //   messages: [{ role: "system", content: buildSystemPrompt(snapshot) }, ...messages],
  //   tools:    [...],
  //   stream:   true,
  // });
  // return new Response(completion.toReadableStream());

  // ── Stub response until an AI provider is connected ─────────────────────────
  return NextResponse.json(
    {
      stub:    true,
      message: "AI agent not connected yet. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and uncomment the relevant section in app/api/agent/route.ts.",
      received: { messageCount: messages.length, hasSnapshot: !!snapshot },
    },
    { status: 501 }
  );
}

// ── System prompt builder (used by both providers) ───────────────────────────

function _buildSystemPrompt(snapshot?: MarketSnapshot): string {
  const base = `You are TP3, a quantitative trading assistant for XAU/USD (Gold Futures).
You have access to the following tools:
- run_backtest: run a backtest with given config and return results
- save_operation: save a new trade operation to the database

Rules:
- Always cite the EV/trade and Win Rate when making recommendations
- Never recommend a trade without checking the 6-condition checklist first
- Default SL = 1.5%, TP = 4.0% unless backtest shows a better configuration
- Respond in the same language as the user`;

  if (!snapshot) return base;

  return `${base}

## Current market snapshot (${new Date(snapshot.timestamp).toLocaleString("es-CO")})
- Price: $${snapshot.price.toFixed(2)}
- HTF signal: ${snapshot.htfSignal}
- MTF signal: ${snapshot.mtfSignal}
- Session: ${snapshot.session}
- Checklist: ${Object.entries(snapshot.checklist)
    .map(([k, v]) => `${v ? "✓" : "✗"} ${k}`)
    .join(", ")}
${snapshot.lastBacktest
  ? `- Last backtest: ${snapshot.lastBacktest.label} WR ${snapshot.lastBacktest.summary.wr}% EV ${snapshot.lastBacktest.summary.ev?.toFixed(2)}R`
  : ""}`;
}
