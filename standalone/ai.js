// Optional decision-model review ("Super Meridian"). Uses the OpenRouter
// Decisions API — the "System One" endpoint (POST /api/alpha/decisions) for
// typed decision models such as TypeSafe Jev (typesafe/jev-1.14). These are not
// chat LLMs: they take state plus typed questions and return probabilities.
// Any decision model on OpenRouter can be used by changing `model`.
//
// The decision model has veto power only: it reviews candidates that already
// passed every deterministic rule. On entry it answers "open this position?"
// (noul) and, when several pools passed screening, "which pool?" (choice). On a
// soft exit it answers "close now?" (noul). It can never create an entry, size
// a position, bypass a guard, or block a stop loss. Disabled, unconfigured,
// timed out, or unusable answers → rule-only behaviour.

import { config } from "../config.js";
import { log } from "../logger.js";
import { recallForPool } from "../pool-memory.js";
import { appendDecision } from "../decision-log.js";

const num = (v, digits = 4) => {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
};
// Token names/symbols are attacker-controlled; keep strings short and inert.
const text = (v, max = 40) => v == null ? null : String(v).replace(/[^\w .:%/+-]/g, "").slice(0, max) || null;

export const QUESTIONS = {
  open_position: {
    type: "noul",
    instructions: "A smart-wallet convergence signal passed all rule-based token and pool filters. Should the bot open this single-sided SOL LP position now?",
    criteria: {
      true: "The token and pool data look healthy: real organic activity, enough holders and liquidity, fees that justify the risk, and no history of repeated losses in this pool.",
      false: "The data suggests a likely rug, dump, wash trading, a crowded or exhausted move, or a pool with a poor track record.",
    },
  },
  close_now: {
    type: "noul",
    instructions: "A rule-based exit (take profit, trailing take profit, out of range, or low yield) fired for this LP position. Should the bot close it now?",
    criteria: {
      true: "Closing now is better: gains could fade, the position is unlikely to return to range, or fees no longer justify staying.",
      false: "Holding a little longer is clearly better: price is likely to come back into range or fees are about to improve.",
    },
  },
};

export function aiStatus(ai = config.ai) {
  if (!ai?.enabled) return { active: false, why: "disabled" };
  if (!ai.apiKey) return { active: false, why: "no API key (set OPENROUTER_API_KEY)" };
  if (!ai.model) return { active: false, why: "no model configured" };
  return { active: true, why: null };
}

const poolFacts = pool => ({
  tvl_usd: num(pool?.tvl, 0),
  active_tvl_usd: num(pool?.active_tvl, 0),
  volume_usd: num(pool?.volume, 0),
  fee_active_tvl_ratio: num(pool?.fee_active_tvl_ratio),
  bin_step: num(pool?.dlmm_params?.bin_step, 0),
  volatility: num(pool?.volatility),
  pool_memory: recallForPool(pool?.pool_address) ?? "no history",
});

// Choice option keys must be stable identifiers the model can echo back.
export const poolKey = (pool, i) => `pool_${i + 1}`;

export function buildEntryState({ signal, token, pools, amountSol }, now = Date.now()) {
  const created = Date.parse(token?.createdAt);
  return {
    signal: {
      wallets: signal.events.length,
      deposits_sol: signal.events.map(e => num(e.depositSol, 3)),
      seconds_since_first_entry: num((now - Math.min(...signal.events.map(e => e.at))) / 1000, 0),
    },
    token: {
      symbol: text(token?.symbol, 16),
      mcap_usd: num(token?.mcap, 0),
      holders: num(token?.holderCount, 0),
      organic_score: num(token?.organicScore, 1),
      top10_pct: num(token?.audit?.topHoldersPercentage, 2),
      bot_holders_pct: num(token?.audit?.botHoldersPercentage, 2),
      global_fees_sol: num(token?.fees, 2),
      launchpad: text(token?.launchpad, 24),
      age_hours: Number.isFinite(created) ? num((now - created) / 3600_000, 1) : null,
    },
    pools: Object.fromEntries(pools.map((p, i) => [poolKey(p, i), poolFacts(p)])),
    plan: { amount_sol: num(amountSol, 3), strategy: config.strategy.strategy, timeframe: config.screening.timeframe },
  };
}

export function buildExitState(position, rule) {
  return {
    proposed_exit: { rule: text(rule.action, 24), reason: text(rule.reason, 160) },
    position: {
      pair: text(position.pair, 24),
      pnl_pct: num(position.pnl_pct, 2),
      total_value_usd: num(position.total_value_usd, 2),
      unclaimed_fees_usd: num(position.unclaimed_fees_usd, 2),
      fee_per_tvl_24h: num(position.fee_per_tvl_24h, 2),
      age_minutes: num(position.age_minutes, 0),
      in_range: position.in_range ?? null,
      active_bin: position.active_bin ?? null,
      lower_bin: position.lower_bin ?? null,
      upper_bin: position.upper_bin ?? null,
      minutes_out_of_range: num(position.minutes_out_of_range, 0),
    },
    pool_memory: recallForPool(position.pool) ?? "no history",
  };
}

// POST to the Decisions API. Throws on transport/HTTP errors.
async function decide(state, questions, ai) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ai.timeoutSec) * 1000);
  try {
    const res = await fetch(ai.decisionsUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ai.apiKey}`,
        // OpenRouter attribution headers.
        "HTTP-Referer": "https://github.com/bangjohn/super-meridian",
        "X-Title": "Super Meridian",
      },
      body: JSON.stringify({ model: ai.model, state, questions, session_id: "super-meridian" }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(`HTTP ${res.status}${err?.error?.message ? ` ${String(err.error.message).slice(0, 120)}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Probability of "yes" from a noul answer, or null when unusable.
export function noulProbability(body, name) {
  const p = Number(body?.answers?.[name]?.noul);
  return Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

// Selected option from a choice answer, or null when not one of `keys`.
export function choiceAnswer(body, name, keys) {
  const a = body?.answers?.[name];
  if (!a || !keys.includes(a.choice)) return null;
  const confidence = Number(a.confidence);
  return { choice: a.choice, confidence: Number.isFinite(confidence) ? confidence : null };
}

function record(ai, kind, approve, p, threshold, latency, extra = {}) {
  if (ai.logDecisions === false) return;
  try {
    appendDecision({
      type: `ai_${kind}`,
      actor: "AI",
      pool: extra.pool ?? null,
      position: extra.position ?? null,
      summary: `${approve ? "approve" : "reject"} via ${ai.model} (p=${p.toFixed(2)})`,
      reason: extra.reason ?? `p(yes)=${p.toFixed(2)} vs threshold ${threshold}`,
      metrics: { p, threshold, latency_ms: latency, ...(extra.metrics ?? {}) },
    });
  } catch { /* decision log is best-effort */ }
}

const fallback = (kind, failure, ai) => {
  // Entries may be configured to fail closed; exits always fall back to the rules.
  const approve = !(kind === "entry" && ai.onError === "reject");
  log("ai_warn", `Decision model ${kind} review failed (${failure}) — ${approve ? "falling back to rules" : "rejecting entry"}`);
  return { approve, p: null, reason: `decision model unavailable (${failure})`, source: "rules" };
};
const failureText = (e, ai) => e.name === "AbortError" ? `timeout after ${ai.timeoutSec}s` : e.message;

// Entry review. `pools` are the rule-approved candidates, best first.
// Always resolves: { approve, p, pool, reason, source: "ai" | "rules" }.
export async function reviewEntry({ signal, token, pools, amountSol }, ai = config.ai) {
  const status = aiStatus(ai);
  if (!status.active || !ai.reviewEntries) {
    return { approve: true, p: null, pool: pools[0], reason: status.active ? "entry review off" : `decision model off (${status.why})`, source: "rules" };
  }
  const keys = pools.map(poolKey);
  const questions = { open_position: QUESTIONS.open_position };
  if (keys.length > 1) {
    questions.best_pool = {
      type: "choice",
      instructions: "Which candidate pool is the best place to provide liquidity for this signal?",
      criteria: Object.fromEntries(keys.map(k => [k, `Choose ${k} when its liquidity, fee yield, volatility, and pool memory are the strongest of the candidates.`])),
    };
  }
  const started = Date.now();
  let body;
  try {
    body = await decide(buildEntryState({ signal, token, pools, amountSol }), questions, ai);
  } catch (e) {
    return { ...fallback("entry", failureText(e, ai), ai), pool: pools[0] };
  }
  const p = noulProbability(body, "open_position");
  if (p == null) return { ...fallback("entry", "unusable answer", ai), pool: pools[0] };

  // Fall back to the rule ranking when the choice is missing or unknown.
  const picked = keys.length > 1 ? choiceAnswer(body, "best_pool", keys) : null;
  const pool = picked ? pools[keys.indexOf(picked.choice)] : pools[0];
  const approve = p >= ai.minEntryProbability;
  const latency = Date.now() - started;
  const reason = `p(open)=${p.toFixed(2)} vs ${ai.minEntryProbability}${picked ? `, picked ${picked.choice} of ${keys.length}` : ""}`;
  log("ai", `entry ${approve ? "APPROVE" : "REJECT"} (${ai.model}, ${latency}ms): ${reason}`);
  record(ai, "entry", approve, p, ai.minEntryProbability, latency, {
    pool: pool?.pool_address, reason, metrics: { cost_usd: body?.usage?.cost ?? null, choice: picked?.choice ?? null },
  });
  return { approve, p, pool, reason, source: "ai" };
}

// Soft-exit review. Always resolves: { approve, p, reason, source }.
export async function reviewExit(position, rule, ai = config.ai) {
  const status = aiStatus(ai);
  if (!status.active || !ai.reviewExits) return { approve: true, p: null, reason: "exit review off", source: "rules" };
  const started = Date.now();
  let body;
  try {
    body = await decide(buildExitState(position, rule), { close_now: QUESTIONS.close_now }, ai);
  } catch (e) {
    return fallback("exit", failureText(e, ai), ai);
  }
  const p = noulProbability(body, "close_now");
  if (p == null) return fallback("exit", "unusable answer", ai);
  const approve = p >= ai.minExitProbability;
  const latency = Date.now() - started;
  const reason = `p(close)=${p.toFixed(2)} vs ${ai.minExitProbability} for ${rule.reason}`;
  log("ai", `exit ${approve ? "CLOSE" : "HOLD"} ${position.pair ?? position.position.slice(0, 8)} (${ai.model}, ${latency}ms): ${reason}`);
  record(ai, "exit", approve, p, ai.minExitProbability, latency, {
    pool: position.pool, position: position.position, reason, metrics: { cost_usd: body?.usage?.cost ?? null },
  });
  return { approve, p, reason, source: "ai" };
}

// ─── Exit holds ─────────────────────────────────────────────────────────────
// A rejected exit is held, never cancelled: the model is re-asked every
// exitRecheckSec, and after maxExitHoldMinutes the rule closes regardless.
// Stop loss is never sent to the model.

const holds = new Map();

export function isHardExit(rule) {
  return rule?.action === "STOP_LOSS" || /stop loss/i.test(rule?.reason ?? "");
}

// Returns true when the close should proceed now.
export async function exitAllowed(position, rule, ai = config.ai, now = Date.now()) {
  if (isHardExit(rule) || !aiStatus(ai).active || !ai.reviewExits) return true;
  const id = position.position;
  const hold = holds.get(id);
  if (hold && now - hold.since >= ai.maxExitHoldMinutes * 60_000) {
    log("ai", `${position.pair ?? id.slice(0, 8)}: hold expired after ${ai.maxExitHoldMinutes}m — closing on rule (${rule.reason})`);
    holds.delete(id);
    return true;
  }
  if (hold && now < hold.nextReviewAt) return false;
  const verdict = await reviewExit(position, rule, ai);
  if (verdict.approve) {
    holds.delete(id);
    return true;
  }
  holds.set(id, { since: hold?.since ?? now, nextReviewAt: now + ai.exitRecheckSec * 1000, reason: verdict.reason });
  return false;
}

export function clearExitHold(positionAddress) {
  holds.delete(positionAddress);
}

export const _test = { holds };
