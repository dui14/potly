# Potly

Conditional group pots in USDC on Arc. A creator sets a funding target and a deadline. Contributors chip in any amount. When the target is fully raised, anyone can trigger payout to the recipient. If the deadline passes unfilled, everyone withdraws their own contribution.

Built with [Arc Studio](https://studio.arc.io)

## Tech stack

- Solidity 0.8.28, OpenZeppelin 5, Foundry
- React 18, TypeScript, Vite, Tailwind CSS
- wagmi v2, viem, ConnectKit
- Supabase (aliases and pot metadata, optional)
- Vercel Functions (API routes)
- Arc Testnet (USDC as native gas)

## Development

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Foundry](https://getfoundry.sh)

### Install

```bash
bun install
forge install
```

### Environment variables

| Variable | Purpose |
|---|---|
| `VITE_ARC_NETWORK` | `testnet` or `mainnet` |
| `VITE_POTLY_ADDRESS` | Deployed Potly contract address |
| `VITE_POTLY_DEPLOY_BLOCK` | Block number the contract was deployed at |
| `VITE_TREASURY_ADDRESS` | Treasury address (for display only) |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect Cloud project ID |
| `VITE_SUPABASE_URL` | Supabase project URL (optional) |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key (optional, browser-safe) |
| `POTLY_ADDRESS` | Contract address for API routes |
| `ARC_NETWORK` | `testnet` or `mainnet` for API routes |
| `ARC_RPC_URL` | RPC endpoint for API routes |
| `SUPABASE_URL` | Supabase URL for API routes (server-only) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-only, never in src/) |

Copy `.env.example` to `.env` and fill in values. The app works without Supabase; alias features show a notice and titles fall back to "Pot #id".

### Run

```bash
bun run dev
```

### Build

```bash
bun run build
```

### Test (contracts)

```bash
forge test --gas-report
```

## Deployed contracts

| Network | Address | Block | Transaction hash |
|---|---|---|---|
| Arc Testnet | `0xb9df333d7c5c9a6ee82db13fa3019855e7fca880` | 69337210 | [0x7f44affc62c673dde12348bd3b1b371a878e678b9f6b7346a85c9ddc3afb4246](https://explorer.testnet.arc.io/tx/0x7f44affc62c673dde12348bd3b1b371a878e678b9f6b7346a85c9ddc3afb4246) |
| Arc Mainnet | | | |

