# Meridian

Standalone wallet-triggered Meteora DLMM bot for Solana. It waits for fresh LP entries by tracked wallets, screens the matching token, and manages positions with deterministic rules. No LLM or Meridian server is required.

## Flow

1. Watch tracked LP wallets through Solana WebSocket notifications, with signature backfill for missed events.
2. Count distinct wallets adding meaningful quote-side liquidity to the same **mint address**, across pools, within a rolling window (default: two wallets in 120 seconds).
3. Screen that mint and its eligible token/SOL pools using Meteora and Jupiter data and on-chain token checks.
4. Recheck exposure, price movement, balances, and transaction safety before entry. Failed screening waits within a bounded deadline.
5. Monitor positions independently and execute rule-based closes and fee claims.

Shadow mode is the default and forces `DRY_RUN=true` for all transaction paths. It records proposals without submitting them. Read [user-config.example.json](user-config.example.json) for supported settings. Monitoring and screening implementation details are in [standalone/](standalone/).

## Decision model (optional)

Super Meridian can ask a decision model for a second opinion through the [OpenRouter Decisions API](https://openrouter.ai/docs/guides/community/jev), the "System One" endpoint (`POST https://openrouter.ai/api/alpha/decisions`). Decision models such as TypeSafe Jev (`typesafe/jev-1.14`) are not chat LLMs: they take the bot's data as `state` plus typed questions and return probabilities. Any decision model on OpenRouter works by changing `model`.

- **Entry:** after a signal passes every rule, the model answers `open_position` (yes/no probability). When several pools passed screening, it also picks one (`best_pool` choice). Below `minEntryProbability` the signal is skipped.
- **Exit:** take profit, trailing TP, out-of-range and low-yield exits are reviewed with `close_now`. Below `minExitProbability` the exit is held and re-asked every `exitRecheckSec`; after `maxExitHoldMinutes` it closes anyway. Stop loss is never sent to the model.
- **Fallback:** disabled, missing key, timeout or an unusable answer means the rules decide alone (set `onError: "reject"` to skip entries instead).

The model can only veto or choose among rule-approved options; it never opens a trade on its own or bypasses a guard. Pool memory is included as context. Every decision goes to `decision-log.json`.

Enable it with `OPENROUTER_API_KEY` in `.env` and `aiDecision.enabled: true` in `user-config.json` (see [user-config.example.json](user-config.example.json)). Probabilities differ between models, so retune the thresholds on your shadow-mode results when switching. Pin a model version (for example `typesafe/jev-1.14`) to keep thresholds stable.

## Setup

Use Node.js 18 or newer and a Solana RPC provider supporting WebSocket subscriptions and transaction history.

```sh
npm install
npm run setup
node cli.js wallets add --wallet ADDRESS --name NAME
node cli.js wallets add --wallet OTHER_ADDRESS --name OTHER_NAME
npm start
```

Setup writes `user-config.json` and starts with shadow mode enabled. It preserves existing settings when prompts are left blank. Set credentials in your environment or local `.env`; see [.env.example](.env.example). For read-only operation, `WALLET_ADDRESS` / `walletAddress` can identify the portfolio without a private key. Live signing requires `WALLET_PRIVATE_KEY`.

Supported infrastructure overrides:

| Variable | Purpose |
|---|---|
| `RPC_URL` | Default Solana endpoint and transaction submission |
| `MONITOR_RPC_URL`, `MONITOR_WS_URL` | Wallet monitoring endpoints |
| `BALANCE_RPC_URL` | Standard SOL and token balance reads |
| `FALLBACK_RPC_URL` | Fallback for monitor/balance reads |
| `PNL_SOURCE` | `meteora` (default) or `rpc` |
| `PNL_RPC_URL` | Optional on-chain PnL engine endpoint |
| `JUPITER_API_KEY` | Jupiter price and swap access |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional outbound notifications |
| `OPENROUTER_API_KEY` | Optional decision-model review (OpenRouter System One) |
| `AI_DECISION_MODEL` | Overrides `aiDecision.model` |

Balances use standard RPC, including SPL Token and Token-2022. PnL defaults to Meteora portfolio and position APIs, with an on-chain fallback. Jupiter supplies prices, token data, and swaps. See [Telegram](#telegram) for notifications and in-chat commands.

## Telegram

1. In Telegram, message `@BotFather`, send `/newbot`, and copy the token.
2. Message `@userinfobot` to get your numeric id. Send any message to your new bot once so it can reply to you.
3. Add to `.env`, then restart:

   ```sh
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=your_id
   TELEGRAM_ALLOWED_USER_IDS=your_id
   ```

The bot reports start/stop, entries and shadow proposals, deploys, closes with PnL, swaps, and failures (aborted signals, failed entries, failed closes or claims; each repeats at most every 30 minutes). With `TELEGRAM_ALLOWED_USER_IDS` set, `/status`, `/menu`, `/wallets`, `/addwallet <address> <name>` and `/removewallet <address>` work in chat; messages from other users are ignored. `telegramChatId` in `user-config.json` overrides `TELEGRAM_CHAT_ID`.

To enable live trading, review your thresholds, wallet list, and shadow results, set `shadowMode` to `false`, remove any `DRY_RUN=true` override, and restart. Configuration edits take effect after restart.

## Commands

```sh
node cli.js help
node cli.js status
node cli.js balance
node cli.js positions
node cli.js screen --mint ADDRESS
node cli.js pool --pool ADDRESS
node cli.js manage --dry-run
node cli.js close --position ADDRESS --dry-run
node cli.js performance
```

`screen --mint` is read-only and never deploys. New entries are available only through wallet convergence. Manual close, claim, and swap operations remain available; run `help` for arguments. The CLI no longer writes skills into your home directory.

For a managed daemon:

```sh
npm run pm2:start
npm run pm2:logs
```

## Local state

Wallets, settings, position state, signal checkpoints, decisions, and logs stay local and are ignored by Git. `performance.js` retains closed-position accounting in the existing `lessons.json` file so historical records remain readable; it does not generate LLM lessons or contact HiveMind. Pool history and cooldowns remain in `pool-memory.json`.

A `submitting` attempt left by a restart needs on-chain reconciliation before that mint can be attempted again. Do not erase recovery state to bypass it.

## Validation

```sh
npm test
```

This checks JavaScript syntax, the standalone signal/rule tests, module imports, CLI behavior, and the Meteora PnL path with mocked data. Tests do not submit transactions.

## Legacy archive

The local **`legacy` branch** preserves the complete pre-cleanup snapshot at **`fd835b7`**, including the earlier LLM runtime in its history. The branch was advanced without rewriting any commits. No archive directory is loaded by the new application.

```sh
git show legacy:agent.js
git show legacy:tools/screening.js
git log legacy
```

The archive includes the old prompts/tool catalog, broad scanning, HiveMind and lesson evolution, LPAgent/Meridian relays, top-LPer studies, chart indicators, GMGN enrichment, Discord listener, Claude agent presets, and old setup/CLI. It has not been pushed automatically.
