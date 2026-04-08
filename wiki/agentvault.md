---
title: AgentVault
date: 2026-04-08
tags: [ai-agents, icp, blockchain, web3, deployment]
sources: [github.com/johnnyclem/agentvault]
---

# AgentVault

> Persistent On-Chain AI Agent Platform — Sovereign, Reconstructible, Autonomous

## What It Is

**AgentVault** is an open-source CLI and canister system that enables true autonomy for local AI agents. Deploy agents to **Internet Computer (ICP)** canisters for persistent, 24/7 execution without browser dependencies.

## Core Features

- **Agent Packaging** — Compile TypeScript agents to WASM
- **Canister Deployment** — Deploy to ICP local replica or mainnet
- **State Management** — Query, fetch, and reconstruct agent state
- **Multi-Chain Wallets** — ICP, Ethereum, Polkadot, Solana support
- **VetKeys Integration** — Threshold key derivation for secure secrets
- **Monitoring** — Health checks, metrics, and alerting
- **Archival** — Arweave integration for permanent storage
- **AI Inference** — Bittensor network integration

## CLI Commands

### Main Flow
| Command | Description |
|---------|-------------|
| `init` | Initialize new AgentVault project |
| `package` | Package agent to WASM |
| `deploy` | Deploy agent to ICP canister |
| `exec` | Execute task on canister |
| `show` | Show agent state |
| `fetch` | Download agent state |

### Wallet
| Command | Description |
|---------|-------------|
| `wallet` | Manage agent wallets |
| `identity` | Manage ICP identities |
| `cycles` | Manage canister cycles |
| `tokens` | Query token balances |

### Monitoring
| Command | Description |
|---------|-------------|
| `monitor` | Monitor canister health |
| `health` | Run health checks |
| `info` | Get canister information |

## Architecture

```
agentvault/
├── src/           # Core TypeScript library
│  ├── deployment/ # ICP client and deployment
│  ├── packaging/  # WASM compilation
│  ├── canister/   # Actor bindings
│  ├── wallet/     # Multi-chain wallet
│  ├── security/   # VetKeys and encryption
│  ├── monitoring/ # Health and metrics
│  ├── archival/   # Arweave client
│  └── inference/  # Bittensor client
├── cli/           # CLI commands
├── canister/      # Motoko canister code
├── webapp/        # Next.js dashboard
└── tests/         # 508 tests
```

## Quick Start

```bash
npm install -g agentvault
agentvault init my-agent
agentvault package ./my-agent
dfx start --background
agentvault deploy --network local
agentvault exec --canister-id <id> "your task"
```

## Status

| Feature | Status |
|---------|--------|
| Core flow (init → package → deploy → exec → fetch) | ✅ Working |
| Wallet crypto | ⚠️ Basic |
| VetKeys | ⚠️ Simulated |
| Bittensor inference | ⚠️ Requires API |
| Arweave archival | ⚠️ Requires wallet |

## Related

- Website: [agentvault.cloud](https://agentvault.cloud)
- Full stack with [[smallchat]] (tool dispatch) + [[short-hand]] (context management)
