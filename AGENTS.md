# Potly — Agent Notes

## Deployed Contracts

| Network | Address | Deploy Tx | Block |
|---|---|---|---|
| Arc Testnet (v1) | `0x39d2790e2842338142e9aedd0b227225d3d48f0e` | `0x784bea798d179a2f9602a6ec56204be36e7a5705a7bb617314cdc49541fe8b1d` | 69167924 |
| Arc Testnet (v2) | `0xb9df333d7c5c9a6ee82db13fa3019855e7fca880` | `0x7f44affc62c673dde12348bd3b1b371a878e678b9f6b7346a85c9ddc3afb4246` | 69337210 |

Constructor args: usdc=`0x3600000000000000000000000000000000000000`, treasury=`0x2d59d71a027483d53dee8f320cce6147eb7cd891`, feeBps=5, maxPotTotal=500000000

## v2 Contract (not yet deployed)

Constructor args for next deploy (unchanged from v1):
- `_usdc`: `0x3600000000000000000000000000000000000000`
- `_treasury`: `0x2D59D71A027483d53dEe8F320CcE6147eB7cD891`
- `_feeBps`: `5`
- `_maxPotTotal`: `500000000`

v2 changes from v1: flexible contributions (any amount, any wallet), up to 100 distinct contributors, `deposit(potId, amount)`, `withdraw(potId, amount)`, `contributionOf(potId, who)`, `remaining(potId)`, `claimPayout` callable by anyone (pays recipient only). Security review: 0 High, 0 Medium, 2 Low (both accepted by design). 73/73 tests pass.

Full review: `docs/security-review-v2.md`

## Key Decisions
- Metadata hash: `keccak256(abi.encode(string title, string note, bytes32 salt))`
- Salt: client-generated random bytes32; stored in localStorage by chainId+potId
- maxPotTotal: 500_000_000 (500 USDC, 6 dec)
- UI: Arc Dark theme, mobile-first
- ABI: copied into `src/lib/potlyAbi.ts` as typed constant
- Slither: NOT run (Slither was not available in the sandbox during the review)

## Remappings (portable, no absolute paths)
- `@openzeppelin/contracts/ → lib/openzeppelin-contracts/contracts/`
- `forge-std/ → lib/forge-std/src/`

After a fresh clone: `bun install && forge install && forge build`
