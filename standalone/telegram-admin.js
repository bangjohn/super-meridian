// Telegram admin console: inline menus grouped by function. Every change is
// persisted (user-config.json or .env) and applied live where possible;
// restart-flagged settings say so and offer the restart button.
//
// Authorization is enforced by startAdminPolling (TELEGRAM_ALLOWED_USER_IDS).

import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets } from "../smart-wallets.js";
import { sendMessage, sendMenu, editMenu, answerCallbackQuery, startAdminPolling } from "../telegram.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const ENV_PATH = repoPath(".env");

// ─── Settings schema ─────────────────────────────────────────────────────────
// k: user-config key (or ENV: key for .env-backed entries)
// path: live config object path; type drives validation + rendering.
const SECTIONS = [
  {
    id: "trigger", title: "🚦 Trigger", desc: "Convergence detection",
    settings: [
      { k: "walletThreshold", path: ["standalone", "walletThreshold"], type: "int", min: 1, max: 10, unit: "wallets" },
      { k: "walletWindowSec", path: ["standalone", "windowSec"], type: "int", min: 10, max: 3600, unit: "s" },
      { k: "screeningDeadlineSec", path: ["standalone", "screeningDeadlineSec"], type: "int", min: 10, max: 600, unit: "s" },
      { k: "screeningRetrySec", path: ["standalone", "retrySec"], type: "int", min: 3, max: 120, unit: "s" },
      { k: "minSmartWalletDepositSol", path: ["standalone", "minDepositSol"], type: "float", min: 0, max: 1000, unit: "SOL" },
      { k: "maxEntryPriceMovePct", path: ["standalone", "maxPriceMovePct"], type: "float", min: 0.1, max: 100, unit: "%" },
      { k: "walletSignalCooldownSec", path: ["standalone", "cooldownSec"], type: "int", min: 0, max: 86400, unit: "s" },
    ],
  },
  {
    id: "screening", title: "🛡 Screening", desc: "Token & pool filters (per triggered mint)",
    settings: [
      { k: "timeframe", path: ["screening", "timeframe"], type: "enum", options: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"] },
      { k: "minTvl", path: ["screening", "minTvl"], type: "int", min: 0, max: 10_000_000, unit: "$" },
      { k: "maxTvl", path: ["screening", "maxTvl"], type: "int", min: 0, max: 100_000_000, unit: "$" },
      { k: "minVolume", path: ["screening", "minVolume"], type: "int", min: 0, max: 10_000_000, unit: "$" },
      { k: "minHolders", path: ["screening", "minHolders"], type: "int", min: 0, max: 100_000 },
      { k: "minMcap", path: ["screening", "minMcap"], type: "int", min: 0, max: 100_000_000, unit: "$" },
      { k: "maxMcap", path: ["screening", "maxMcap"], type: "int", min: 0, max: 1_000_000_000, unit: "$" },
      { k: "minBinStep", path: ["screening", "minBinStep"], type: "int", min: 1, max: 5000 },
      { k: "maxBinStep", path: ["screening", "maxBinStep"], type: "int", min: 1, max: 5000 },
      { k: "minFeeActiveTvlRatio", path: ["screening", "minFeeActiveTvlRatio"], type: "float", min: 0, max: 10 },
      { k: "minTokenFeesSol", path: ["screening", "minTokenFeesSol"], type: "float", min: 0, max: 10_000, unit: "SOL" },
      { k: "maxTop10Pct", path: ["screening", "maxTop10Pct"], type: "float", min: 0, max: 100, unit: "%" },
      { k: "maxBotHoldersPct", path: ["screening", "maxBotHoldersPct"], type: "float", min: 0, max: 100, unit: "%" },
      { k: "minOrganic", path: ["screening", "minOrganic"], type: "int", min: 0, max: 100 },
      { k: "minQuoteOrganic", path: ["screening", "minQuoteOrganic"], type: "int", min: 0, max: 100 },
      { k: "minTokenAgeHours", path: ["screening", "minTokenAgeHours"], type: "nullable", unit: "h" },
      { k: "maxTokenAgeHours", path: ["screening", "maxTokenAgeHours"], type: "nullable", unit: "h" },
      { k: "allowedLaunchpads", path: ["screening", "allowedLaunchpads"], type: "list" },
      { k: "blockedLaunchpads", path: ["screening", "blockedLaunchpads"], type: "list" },
    ],
  },
  {
    id: "risk", title: "📏 Risk & sizing", desc: "Portfolio limits and deploy size",
    settings: [
      { k: "maxPositions", path: ["risk", "maxPositions"], type: "int", min: 1, max: 50 },
      { k: "deployAmountSol", path: ["management", "deployAmountSol"], type: "float", min: 0.01, max: 10_000, unit: "SOL" },
      { k: "maxDeployAmount", path: ["risk", "maxDeployAmount"], type: "float", min: 0.01, max: 10_000, unit: "SOL" },
      { k: "positionSizePct", path: ["management", "positionSizePct"], type: "float", min: 0.01, max: 1, unit: "fraction" },
      { k: "gasReserve", path: ["management", "gasReserve"], type: "float", min: 0, max: 10, unit: "SOL" },
      { k: "minSolToOpen", path: ["management", "minSolToOpen"], type: "float", min: 0, max: 100, unit: "SOL" },
    ],
  },
  {
    id: "exits", title: "🚪 Exits", desc: "Deterministic close rules",
    settings: [
      { k: "stopLossPct", path: ["management", "stopLossPct"], type: "float", min: -99, max: 0, unit: "%" },
      { k: "takeProfitPct", path: ["management", "takeProfitPct"], type: "float", min: 0, max: 1000, unit: "%" },
      { k: "trailingTakeProfit", path: ["management", "trailingTakeProfit"], type: "bool" },
      { k: "trailingTriggerPct", path: ["management", "trailingTriggerPct"], type: "float", min: 0.1, max: 1000, unit: "%" },
      { k: "trailingDropPct", path: ["management", "trailingDropPct"], type: "float", min: 0.1, max: 100, unit: "%" },
      { k: "outOfRangeBinsToClose", path: ["management", "outOfRangeBinsToClose"], type: "int", min: 0, max: 500 },
      { k: "outOfRangeWaitMinutes", path: ["management", "outOfRangeWaitMinutes"], type: "int", min: 0, max: 10_000, unit: "min" },
      { k: "minClaimAmount", path: ["management", "minClaimAmount"], type: "float", min: 0, max: 1000, unit: "$" },
      { k: "minFeePerTvl24h", path: ["management", "minFeePerTvl24h"], type: "float", min: 0, max: 1000, unit: "%" },
      { k: "oorCooldownTriggerCount", path: ["management", "oorCooldownTriggerCount"], type: "int", min: 1, max: 100 },
      { k: "oorCooldownHours", path: ["management", "oorCooldownHours"], type: "int", min: 1, max: 1000, unit: "h" },
      { k: "pnlConfirmTicks", path: ["pnl", "confirmTicks"], type: "int", min: 1, max: 10, unit: "ticks" },
      { k: "pnlPollIntervalSec", path: ["pnl", "pollIntervalSec"], type: "int", min: 1, max: 60, unit: "s", restart: true },
      { k: "managementIntervalMin", path: ["schedule", "managementIntervalMin"], type: "int", min: 1, max: 1440, unit: "min", restart: true },
      { k: "solMode", path: ["management", "solMode"], type: "bool" },
    ],
  },
  {
    id: "rpc", title: "🌐 RPC & data", desc: "Endpoints (.env) — restart to apply",
    settings: [
      { k: "ENV:RPC_URL", label: "RPC_URL (default)", type: "env", kind: "url", restart: true },
      { k: "ENV:MONITOR_RPC_URL", label: "MONITOR_RPC_URL", type: "env", kind: "url", restart: true },
      { k: "ENV:MONITOR_WS_URL", label: "MONITOR_WS_URL", type: "env", kind: "url", restart: true },
      { k: "ENV:BALANCE_RPC_URL", label: "BALANCE_RPC_URL", type: "env", kind: "url", restart: true },
      { k: "ENV:FALLBACK_RPC_URL", label: "FALLBACK_RPC_URL", type: "env", kind: "url", restart: true },
      { k: "ENV:PNL_RPC_URL", label: "PNL_RPC_URL", type: "env", kind: "url", restart: true },
      { k: "ENV:PNL_SOURCE", label: "PNL_SOURCE", type: "env", kind: "enum", options: ["meteora", "rpc"] },
      { k: "ENV:JUPITER_API_KEY", label: "JUPITER_API_KEY", type: "env", kind: "secret", restart: true },
    ],
  },
];

const byKey = new Map(SECTIONS.flatMap(s => s.settings).map(s => [s.k, s]));

// ─── Persistence ─────────────────────────────────────────────────────────────

function readUserConfig() {
  try { return fs.existsSync(USER_CONFIG_PATH) ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) : {}; }
  catch (e) { throw new Error(`user-config.json is unreadable: ${e.message}`); }
}
function writeUserConfig(patch) {
  const data = { ...readUserConfig(), ...patch };
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
function readEnv() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
}
function envValue(key) {
  const m = readEnv().match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}
function writeEnvValue(key, value) {
  const lines = readEnv().split("\n");
  const idx = lines.findIndex(l => l.startsWith(`${key}=`));
  const entry = `${key}=${value}`;
  if (idx >= 0) lines[idx] = entry;
  else lines.push(entry);
  fs.writeFileSync(ENV_PATH, lines.join("\n"), { mode: 0o600 });
}

function currentValue(setting) {
  if (setting.type === "env") return envValue(setting.k.slice(4));
  let v = config;
  for (const p of setting.path) v = v?.[p];
  return v;
}

// ─── Validation + save ───────────────────────────────────────────────────────

function validate(setting, raw) {
  const text = String(raw).trim();
  if (setting.type === "env") {
    if (setting.kind === "enum" && !setting.options.includes(text)) throw new Error(`Must be one of: ${setting.options.join(", ")}`);
    if (setting.kind === "url" && text && !/^(https?|wss?):\/\//.test(text)) throw new Error("Must be an http(s):// or ws(s):// URL, or empty");
    if (setting.kind === "secret" && /\s/.test(text)) throw new Error("Key must not contain whitespace");
    return text;
  }
  if (setting.type === "bool") {
    if (!["on", "off", "true", "false"].includes(text.toLowerCase())) throw new Error("Send 'on' or 'off'");
    return ["on", "true"].includes(text.toLowerCase());
  }
  if (setting.type === "enum") {
    if (!setting.options.includes(text)) throw new Error(`Must be one of: ${setting.options.join(", ")}`);
    return text;
  }
  if (setting.type === "list") {
    const items = text === "" || text.toLowerCase() === "none" ? [] : text.split(",").map(s => s.trim()).filter(Boolean);
    return items;
  }
  if (setting.type === "nullable") {
    if (["off", "null", "none", "-"].includes(text.toLowerCase())) return null;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) throw new Error("Send a number ≥ 0, or 'off' for no limit");
    return n;
  }
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error("Must be a number");
  if (setting.type === "int" && !Number.isInteger(n)) throw new Error("Must be a whole number");
  if (setting.min != null && n < setting.min) throw new Error(`Minimum is ${setting.min}`);
  if (setting.max != null && n > setting.max) throw new Error(`Maximum is ${setting.max}`);
  return n;
}

function applySetting(setting, value) {
  if (setting.type === "env") {
    writeEnvValue(setting.k.slice(4), value);
    return setting.restart;
  }
  writeUserConfig({ [setting.k]: value });
  // Hot-apply where the runtime reads config live; restart-flagged values say so.
  let target = config;
  for (let i = 0; i < setting.path.length - 1; i++) target = target[setting.path[i]];
  target[setting.path[setting.path.length - 1]] = value;
  return !!setting.restart;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function fmtValue(setting) {
  const v = currentValue(setting);
  if (setting.type === "bool") return v ? "ON" : "OFF";
  if (setting.type === "env" && setting.kind === "secret") return v ? "set ✓" : "not set";
  if (v == null) return "off";
  if (Array.isArray(v)) return v.length ? v.join(",") : "any";
  return `${v}${setting.unit && setting.unit !== "%" ? ` ${setting.unit}` : setting.unit === "%" ? "%" : ""}`;
}

function rootKeyboard() {
  const mode = `🌑 Shadow: ${config.standalone.shadow ? "ON" : "OFF"}`;
  return [
    [{ text: "👛 Wallets", callback_data: "s:wallets" }, { text: "🖥 Status", callback_data: "s:status" }],
    ...SECTIONS.map(s => [{ text: s.title, callback_data: `s:${s.id}` }]),
    [{ text: "🔑 Bot key", callback_data: "s:key" }, { text: mode, callback_data: "m:shadow" }],
    [{ text: "♻️ Restart bot", callback_data: "m:restart" }],
  ];
}

function sectionMenu(section) {
  const rows = section.settings.map(s => [{
    text: `${s.label ?? s.k}: ${fmtValue(s)}`,
    callback_data: s.type === "bool" ? `t:${s.k}` : `e:${s.k}`,
  }]);
  return {
    text: `<b>${section.title}</b>\n<i>${section.desc}</i>\nTap a value to edit${section.id === "rpc" ? " — changes write to .env" : ""}.`,
    keyboard: [...rows, [{ text: "← Back", callback_data: "s:root" }]],
  };
}

function restartRow() {
  return [{ text: "♻️ Restart now", callback_data: "m:restart" }];
}

// ─── State machine ───────────────────────────────────────────────────────────

let pending = null; // { kind, setting?|address?, label }

function cancelKB() {
  return [[{ text: "✖️ Cancel", callback_data: "x:cancel" }]];
}

async function startEdit(setting) {
  pending = { kind: "set", setting };
  const hints = {
    bool: "Send 'on' or 'off'",
    enum: `Send one of: ${setting.options.join(", ")}`,
    list: "Send comma-separated values, or 'none' for an empty list",
    nullable: "Send a number, or 'off' for no limit",
    env: setting.kind === "enum" ? `Send one of: ${setting.options.join(", ")}` : setting.kind === "secret" ? "Send the key" : "Send the URL (empty clears it)",
  };
  await sendMenu(`✏️ <b>${setting.label ?? setting.k}</b>\nCurrent: <code>${fmtValue(setting)}</code>\n\n${hints[setting.type] ?? "Send the new value"}`, cancelKB());
}

async function handleCallback(cb) {
  const data = cb.data || "";
  const messageId = cb.message?.message_id;
  await answerCallbackQuery(cb.id).catch(() => {});
  try {
    if (data === "x:cancel") {
      pending = null;
      await editMenu(messageId, "Cancelled.").catch(() => {});
      return;
    }
    if (data === "s:root") {
      pending = null;
      return void await editMenu(messageId, rootText(), rootKeyboard()).catch(() => sendMenu(rootText(), rootKeyboard()));
    }
    if (data.startsWith("s:")) return void await renderSection(messageId, data.slice(2));
    if (data.startsWith("t:")) {
      const setting = byKey.get(data.slice(2));
      if (!setting) return;
      applySetting(setting, !currentValue(setting));
      const section = SECTIONS.find(s => s.settings.includes(setting));
      const menu = sectionMenu(section);
      await editMenu(messageId, `${menu.text}\n\n✅ Saved`, menu.keyboard).catch(() => {});
      return;
    }
    if (data.startsWith("e:")) {
      const setting = byKey.get(data.slice(2));
      if (setting) await startEdit(setting);
      return;
    }
    if (data === "w:add") {
      pending = { kind: "waddr" };
      return void await sendMenu("👛 Send the wallet <b>address</b>:", cancelKB());
    }
    if (data.startsWith("w:rm2:")) {
      const { wallets } = listSmartWallets();
      const w = wallets[Number(data.slice(6))];
      if (!w) return void await sendMessage("Wallet not found.");
      const res = removeSmartWallet({ address: w.address });
      return void await sendMessage(res.success ? `🗑 Removed ${w.name}` : `⚠️ ${res.error}`);
    }
    if (data.startsWith("w:rm:")) {
      const { wallets } = listSmartWallets();
      const w = wallets[Number(data.slice(5))];
      if (!w) return void await sendMessage("Wallet not found.");
      return void await sendMenu(`Remove <b>${w.name}</b>\n<code>${w.address}</code>?`, [
        [{ text: "🗑 Confirm remove", callback_data: `w:rm2:${data.slice(5)}` }, { text: "✖️ Cancel", callback_data: "s:wallets" }],
      ]);
    }
    if (data === "k:imp") {
      pending = { kind: "pkimport" };
      return void await sendMenu(
        "🔑 Send the private key — base58 secret <b>or</b> JSON byte array.\n\n⚠️ The message will stay in this chat until you delete it.",
        cancelKB(),
      );
    }
    if (data === "k:exp") {
      return void await sendMenu("⚠️ <b>Export sends the private key into this chat.</b>\nTelegram history is kept server-side. Anyone with access to this account gets the key.\n\nExport anyway?", [
        [{ text: "👁 Show key", callback_data: "k:exp2" }, { text: "✖️ Cancel", callback_data: "s:key" }],
      ]);
    }
    if (data === "k:exp2") {
      const raw = process.env.WALLET_PRIVATE_KEY;
      if (!raw) return void await sendMessage("No WALLET_PRIVATE_KEY configured.");
      let kp;
      try { kp = parseSecretKey(raw); } catch { return void await sendMessage("⚠️ Stored key is unreadable."); }
      await sendMessage(`🔑 <code>${bs58.encode(kp.secretKey)}</code>\n\n⚠️ Delete this message from the chat history now.`);
      return;
    }
    if (data === "k:addr") {
      pending = { kind: "walletaddr" };
      return void await sendMenu("📍 Send the read-only wallet <b>address</b> (public key):", cancelKB());
    }
    if (data === "m:shadow") {
      const next = !config.standalone.shadow;
      return void await sendMenu(`Set mode to <b>${next ? "SHADOW (nothing submitted)" : "LIVE"}</b>?`, [
        [{ text: next ? "🌑 Shadow" : "🔴 LIVE", callback_data: "m:shadow2" }, { text: "✖️ Cancel", callback_data: "s:root" }],
      ]);
    }
    if (data === "m:shadow2") {
      const next = !config.standalone.shadow;
      writeUserConfig({ shadowMode: next });
      config.standalone.shadow = next;
      // Transaction paths read DRY_RUN per call; honor an explicit .env DRY_RUN when going live.
      if (next) process.env.DRY_RUN = "true";
      else if (envValue("DRY_RUN") !== "true") delete process.env.DRY_RUN;
      await sendMessage(`✅ Mode: <b>${next ? "SHADOW" : "LIVE"}</b>${next ? "" : "\n🔴 The bot will now SUBMIT real transactions."}`);
      return;
    }
    if (data === "m:restart") {
      return void await sendMenu("♻️ Restart the bot? (takes ~5s)", [
        [{ text: "♻️ Confirm restart", callback_data: "m:restart2" }, { text: "✖️ Cancel", callback_data: "s:root" }],
      ]);
    }
    if (data === "m:restart2") return void requestRestart();
  } catch (e) {
    log("telegram_error", `admin callback failed: ${e.message}`);
    await sendMessage(`⚠️ ${e.message}`).catch(() => {});
  }
}

async function renderSection(messageId, sectionId) {
  if (sectionId === "wallets") {
    const { wallets } = listSmartWallets();
    const rows = wallets.map((w, i) => [{ text: `🗑 ${w.name}`, callback_data: `w:rm:${i}` }]);
    return void await editMenu(messageId,
      `👛 <b>Monitored wallets</b> (${wallets.length})\n${wallets.map(w => `• <b>${w.name}</b>\n<code>${w.address}</code>`).join("\n") || "none — add at least 2 to trigger entries"}`,
      [...rows, [{ text: "➕ Add wallet", callback_data: "w:add" }, { text: "← Back", callback_data: "s:root" }]],
    ).catch(() => {});
  }
  if (sectionId === "key") {
    let deposit = config.standalone.walletAddress || null;
    let keyState = "not set";
    if (process.env.WALLET_PRIVATE_KEY) {
      try {
        deposit = parseSecretKey(process.env.WALLET_PRIVATE_KEY).publicKey.toString();
        keyState = "configured ✓";
      } catch { keyState = "configured but unreadable ⚠️"; }
    }
    let balanceLine = "";
    if (deposit) {
      try {
        const { getWalletBalances } = await import("../tools/wallet.js");
        const b = await getWalletBalances({ nativeOnly: true });
        if (!b.error && Number.isFinite(b.sol)) balanceLine = `\nSOL balance: <b>${b.sol.toFixed(4)}</b>`;
      } catch { /* balance is best-effort */ }
    }
    return void await editMenu(messageId,
      `🔑 <b>Bot wallet</b>\n\n📥 <b>Deposit address:</b>\n<code>${deposit ?? "—"}</code>${balanceLine}\n\nSigning key: ${keyState}\nRead-only override: <code>${config.standalone.walletAddress || "not set"}</code>`,
      [
        [{ text: "📥 Import private key", callback_data: "k:imp" }],
        [{ text: "📤 Export private key", callback_data: "k:exp" }, { text: "📍 Set read-only address", callback_data: "k:addr" }],
        [{ text: "← Back", callback_data: "s:root" }],
      ],
    ).catch(() => {});
  }
  if (sectionId === "status") {
    return void await editMenu(messageId, await statusText(), [[{ text: "🔄 Refresh", callback_data: "s:status" }, { text: "← Back", callback_data: "s:root" }]]).catch(() => {});
  }
  const section = SECTIONS.find(s => s.id === sectionId);
  if (section) await editMenu(messageId, sectionMenu(section).text, sectionMenu(section).keyboard).catch(() => {});
}

function rootText() {
  return `<b>⚙️ Meridian admin</b>\n<i>${config.standalone.shadow ? "🌑 SHADOW — nothing is submitted" : "🔴 LIVE — real transactions"}</i>\nPick a section:`;
}

async function statusText() {
  const stats = adminContext.monitor?.stats ?? {};
  const wallets = listSmartWallets();
  const lines = [
    `🖥 <b>Status</b>`,
    `Mode: ${config.standalone.shadow ? "🌑 SHADOW" : "🔴 LIVE"} | DRY_RUN=${process.env.DRY_RUN === "true"}`,
    `Uptime: ${Math.floor(process.uptime() / 60)} min`,
    `Wallets monitored: ${wallets.total} (trigger: ${config.standalone.walletThreshold} in ${config.standalone.windowSec}s)`,
    `Monitor: tx=${stats.transactions ?? 0} entries=${stats.entries ?? 0} lag=${stats.lastLagMs != null ? `${(stats.lastLagMs / 1000).toFixed(1)}s` : "n/a"} errors=${stats.errors ?? 0}`,
    `Signals active: ${adminContext.activeSignals?.() ?? 0}`,
  ];
  try {
    const { getMyPositions } = await import("../tools/dlmm.js");
    const positions = await getMyPositions({ force: true, silent: true });
    lines.push(`Positions: ${positions.total_positions}${positions.positions.length ? ` (${positions.positions.map(p => `${p.pair ?? "?"} ${p.pnl_pct ?? "?"}%`).join(", ")})` : ""}`);
  } catch { lines.push("Positions: unavailable"); }
  return lines.join("\n");
}

function parseSecretKey(raw) {
  const text = String(raw).trim();
  if (text.startsWith("[")) {
    const bytes = JSON.parse(text);
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error("bad array");
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }
  const bytes = bs58.decode(text);
  if (bytes.length !== 64) throw new Error("bad length");
  return Keypair.fromSecretKey(bytes);
}

function requestRestart() {
  void (async () => {
    await sendMessage("♻️ Restarting — back in a few seconds…").catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    process.exit(1); // systemd Restart=on-failure brings the bot back
  })();
}

async function handleText(text, msg) {
  // Pending edit flows consume the next message.
  if (pending) {
    const p = pending;
    pending = null;
    try {
      if (p.kind === "set") {
        const value = validate(p.setting, text);
        const needs = applySetting(p.setting, value);
        const section = SECTIONS.find(s => s.settings.includes(p.setting));
        const menu = sectionMenu(section);
        await sendMenu(`✅ <b>${p.setting.label ?? p.setting.k}</b> → <code>${fmtValue(p.setting)}</code>${needs ? "\n\n♻️ Applies after restart" : ""}`,
          [...(needs ? [restartRow()] : []), ...menu.keyboard]);
        return;
      }
      if (p.kind === "waddr") {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text.trim())) {
          pending = { kind: "waddr" };
          return void await sendMessage("⚠️ Not a valid Solana address — send it again, or /cancel");
        }
        pending = { kind: "wname", address: text.trim() };
        return void await sendMenu("Name this wallet:", cancelKB());
      }
      if (p.kind === "wname") {
        const name = text.trim().slice(0, 40) || "wallet";
        const res = addSmartWallet({ address: p.address, name });
        return void await sendMessage(res.success ? `✅ Added <b>${name}</b>\n<code>${p.address}</code>` : `⚠️ ${res.error}`);
      }
      if (p.kind === "pkimport") {
        const kp = parseSecretKey(text);
        writeEnvValue("WALLET_PRIVATE_KEY", bs58.encode(kp.secretKey));
        process.env.WALLET_PRIVATE_KEY = bs58.encode(kp.secretKey); // live immediately; .env survives restarts
        return void await sendMenu(`✅ Key imported — wallet <code>${kp.publicKey.toString()}</code>\nSigning is active now (survives restarts).`, [[{ text: "← Bot key", callback_data: "s:key" }]]);
      }
      if (p.kind === "walletaddr") {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text.trim())) return void await sendMessage("⚠️ Not a valid address — send again, or /cancel");
        writeUserConfig({ walletAddress: text.trim() });
        config.standalone.walletAddress = text.trim();
        return void await sendMessage(`✅ Read-only address set: <code>${text.trim()}</code>`);
      }
    } catch (e) {
      return void await sendMessage(`⚠️ ${e.message} — try again or /cancel`);
    }
  }

  const [cmd, ...args] = text.trim().split(/\s+/);
  if (cmd === "/cancel") { pending = null; return void await sendMessage("Cancelled."); }
  if (cmd === "/start" || cmd === "/help" || cmd === "/menu") {
    return void await sendMenu(rootText() + `\n\n/addwallet &lt;address&gt; &lt;name&gt; — add monitored wallet\n/removewallet &lt;address&gt;\n/wallets — list\n/status — bot status\n/cancel — abort an edit`, rootKeyboard());
  }
  if (cmd === "/status") return void await sendMessage(await statusText());
  if (cmd === "/wallets") {
    const { wallets } = listSmartWallets();
    return void await sendMessage(`👛 ${wallets.length} wallet(s):\n${wallets.map(w => `• <b>${w.name}</b> <code>${w.address}</code>`).join("\n") || "none"}`);
  }
  if (cmd === "/addwallet") {
    const address = args[0];
    const name = args.slice(1).join(" ").slice(0, 40) || "wallet";
    const res = addSmartWallet({ address: address ?? "", name });
    return void await sendMessage(res.success ? `✅ Added <b>${name}</b> <code>${address}</code>` : `⚠️ ${res.error}`);
  }
  if (cmd === "/removewallet") {
    const res = removeSmartWallet({ address: args[0] ?? "" });
    return void await sendMessage(res.success ? `🗑 Removed ${res.removed}` : `⚠️ ${res.error}`);
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

const adminContext = { monitor: null, activeSignals: null };

export function startAdmin({ monitor = null, activeSignals = null } = {}) {
  adminContext.monitor = monitor;
  adminContext.activeSignals = activeSignals;
  const stop = startAdminPolling(async ({ message, callback }) => {
    if (callback) await handleCallback(callback);
    else if (message) await handleText(message.text, message);
  });
  return stop;
}
