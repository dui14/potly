`ai-context/arc-facts.md` does not exist in the repo. I'll work from what `spec/idea.md` contains and Arc's known network facts. Here is the consolidated plan.

---

# Potly — Implementation Plan

## 1. Folder Tree

```
potly/
├── contracts/
│   ├── Potly.sol
│   ├── test/
│   │   └── Potly.t.sol
│   ├── out/                         (forge build output, gitignored)
│   └── contract-metadata/
│       └── Potly.json
├── api/
│   ├── healthz.ts
│   └── v1/pots/[chainId]/[potId]/
│       └── metadata.ts
├── src/
│   ├── main.tsx
│   ├── index.css
│   ├── App.tsx
│   ├── config/
│   │   └── wagmi.ts               (chain config, USDC address, explorer URLs)
│   ├── lib/
│   │   ├── share.ts               (getShareBase / buildShareLink)
│   │   ├── potly.ts               (ABI import, contract address, typed helpers)
│   │   ├── usdc.ts                (approve + balance helpers)
│   │   ├── metadata.ts            (hash(title,note,salt), API calls)
│   │   └── errors.ts              (custom error decoder)
│   ├── hooks/
│   │   ├── usePot.ts              (useReadContract getPot + polling)
│   │   ├── useMyPots.ts           (filter PotCreated / Deposited by address)
│   │   └── useGasEstimate.ts      (eth_estimateGas wrapper)
│   └── components/
│       ├── Header.tsx
│       ├── ConnectButton.tsx
│       ├── CreatePotForm.tsx
│       ├── PotPage.tsx
│       ├── SlotGrid.tsx
│       ├── Countdown.tsx
│       ├── StatusBadge.tsx
│       ├── ActionBar.tsx          (Join / Withdraw / Cancel / Claim)
│       ├── TxButton.tsx           (idle→signing→confirming→success/error)
│       ├── ShareStrip.tsx         (link + QR)
│       ├── MyPots.tsx
│       └── ProofStrip.tsx
├── spec/
│   └── idea.md
├── index.html
├── vite.config.ts
├── tailwind.config.js
├── foundry.toml
├── package.json
└── .env.local                     (gitignored)
```

---

## 2. Contract: Solidity Signatures

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
// Dependencies: OpenZeppelin 5 — ReentrancyGuard, IERC20, SafeERC20

contract Potly is ReentrancyGuard {

  // ── Constants ──────────────────────────────────────────────────────────────
  uint256 public constant MIN_SLOTS    = 2;
  uint256 public constant MAX_SLOTS    = 20;
  uint256 public constant MIN_SHARE    = 10_000;   // 0.01 USDC
  uint256 public constant MIN_DURATION = 60;
  uint256 public constant MAX_DURATION = 30 days;
  uint256 public constant CLAIM_WINDOW = 7 days;

  // ── Immutables ─────────────────────────────────────────────────────────────
  IERC20  public immutable usdc;
  address public immutable treasury;
  uint16  public immutable feeBps;       // ≤ 100
  uint256 public immutable maxPotTotal;

  // ── State ──────────────────────────────────────────────────────────────────
  enum Status { OPEN, FILLED, PAID, CANCELLED }

  struct Pot {
    address creator;
    address recipient;
    uint256 share;
    uint256 slots;
    uint256 filled;
    uint256 deadline;
    uint256 filledAt;
    Status  status;
    bytes32 metadataHash;
  }

  uint256 public potCount;
  uint256 public totalLocked;
  mapping(uint256 => Pot)                      private _pots;
  mapping(uint256 => mapping(address => bool)) private _deposited;

  // ── Constructor ────────────────────────────────────────────────────────────
  constructor(address usdc_, address treasury_, uint16 feeBps_, uint256 maxPotTotal_)
  // Reverts: ZeroAddress, NoCode(usdc_), FeeTooHigh(feeBps_)

  // ── Mutating functions (all nonReentrant, CEI) ─────────────────────────────
  function createPot(
    address recipient,
    uint256 share,
    uint256 slots,
    uint256 durationSeconds,
    bytes32 metadataHash
  ) external returns (uint256 potId);

  function deposit(uint256 potId) external;

  function withdraw(uint256 potId) external;

  function cancel(uint256 potId) external;

  function claimPayout(uint256 potId) external;

  function sweepUnaccounted() external;

  // ── Views ──────────────────────────────────────────────────────────────────
  function getPot(uint256 potId) external view returns (Pot memory);
  function hasDeposited(uint256 potId, address who) external view returns (bool);
  function claimDeadline(uint256 potId) external view returns (uint256);
  function isRefundable(uint256 potId) public view returns (bool);
}
```

### Custom Errors

```
ZeroAddress()
NoCode(address target)
FeeTooHigh(uint16 bps)
InvalidSlots(uint256 slots)
InvalidDuration(uint256 duration)
ShareTooSmall(uint256 share)
TotalExceedsMax(uint256 total, uint256 max)
InvalidRecipient()
PotNotOpen(uint256 potId, Status status)
PotNotFilled(uint256 potId, Status status)
AlreadyDeposited(uint256 potId, address caller)
DeadlinePassed(uint256 potId, uint256 deadline)
NoDeposit(uint256 potId, address caller)
NotRefundable(uint256 potId)
NotCreator(uint256 potId, address caller)
NotRecipient(uint256 potId, address caller)
ClaimWindowClosed(uint256 potId)
NothingToSweep()
```

### Events

```
PotCreated(uint256 indexed potId, address indexed creator, address indexed recipient,
           uint256 share, uint256 slots, uint256 deadline, bytes32 metadataHash)
Deposited(uint256 indexed potId, address indexed depositor, uint256 filled)
PotFilled(uint256 indexed potId, uint256 filledAt)
Withdrawn(uint256 indexed potId, address indexed depositor, uint256 amount)
PotCancelled(uint256 indexed potId)
PayoutClaimed(uint256 indexed potId, address indexed recipient, uint256 payout, uint256 fee)
Swept(address indexed by, uint256 amount)
```

---

## 3. State Machine

```
createPot → OPEN
  OPEN + deadline not passed + slot available → deposit → OPEN (filled < slots)
  OPEN + last slot filled                     → deposit → FILLED (+ filledAt)
  OPEN (any time)                             → cancel  → CANCELLED
  OPEN (any time)                             → withdraw (depositors only)

  FILLED + within CLAIM_WINDOW + recipient    → claimPayout → PAID (terminal)
  FILLED + CLAIM_WINDOW expired               → withdraw (depositors reclaim)

  CANCELLED                                   → withdraw (depositors reclaim)

  PAID                                        → no further state transitions
```

---

## 4. Invariants & Test Plan

### Invariants (Foundry `.t.sol`)

1. `usdc.balanceOf(address(potly)) == totalLocked` at all times (excluding direct transfers)
2. After PAID: locked funds of that pot == 0; status cannot change again
3. After all refunds on a CANCELLED/FILLED-expired pot: net locked for that pot == 0
4. `filled <= slots` always
5. `claimPayout` cannot execute twice (PAID is terminal)
6. No `withdraw` succeeds after PAID
7. Fee paid ≤ `total * feeBps / 10_000` (fee rounding never rounds up)
8. `isRefundable` returns false when status == PAID

### Test Cases

| Scenario | Type |
|---|---|
| Happy path: fill all slots, claim within window | unit |
| Partial fill, deadline passes, all depositors withdraw | unit |
| Creator cancels, depositors withdraw | unit |
| Recipient misses claim window, depositors withdraw | unit |
| claimPayout reverts if called twice | unit |
| withdraw reverts after PAID | unit |
| deposit reverts if same address tries twice | unit |
| deposit reverts after deadline | unit |
| deposit reverts when FILLED/PAID/CANCELLED | unit |
| createPot reverts on each invalid arg (share, slots, duration, recipient) | unit |
| Fee rounding: fuzz(share, slots, feeBps) — fee ≤ floor | fuzz |
| State transitions: fuzz random action sequence | fuzz |
| Blacklisted recipient: FILLED, claim fails, window expires, depositors withdraw | unit |
| Reentrancy on deposit/withdraw: mock malicious ERC-20 | unit |
| sweepUnaccounted: direct transfer then sweep | unit |

---

## 5. Frontend

### Network & Chain Config (`src/config/wagmi.ts`)

- Chains: `arcTestnet` (chain ID 5042002) when `VITE_ARC_NETWORK=testnet`; `arc` (5042) when `mainnet`
- RPC: `https://rpc.testnet.arc.io` / `https://rpc.mainnet.arc.io` — passed explicitly to `http()`
- USDC: `0x3600000000000000000000000000000000000000` (6 decimals, same address both networks)
- Explorer: `https://explorer.testnet.arc.io` / `https://explorer.arc.io`

### Route Tree

```
/                   → <HomePage>       (hero + CreatePotForm + ProofStrip)
/p/:chainId/:potId  → <PotPage>        (slot grid, countdown, action bar, share strip)
/my                 → <MyPots>         (list of created + deposited pots)
```

### Component Tree

```
<App>
  <Header>                        (logo, <ConnectButton>, nav links)
  <Routes>
    / → <HomePage>
          <CreatePotForm>         (recipient, share, slots, duration presets,
                                   title, note, total preview, fee note, gas est.)
          <ProofStrip>            (potCount, USDC settled, contract link, treasury link)
    /p/:chainId/:potId → <PotPage>
          <StatusBadge>
          <SlotGrid>              (N squares, filled vs open, depositor addresses)
          <Countdown>             (live tick to deadline or claim deadline)
          <ActionBar>
            <TxButton label="Join">      (approve → deposit two-step)
            <TxButton label="Withdraw">
            <TxButton label="Cancel">    (creator only)
            <TxButton label="Claim">     (recipient only)
          <ShareStrip>            (copy link via buildShareLink, QR via qrcode.react)
    /my → <MyPots>
          list of <PotCard> (links to /p/…)
```

### TxButton State Machine

```
idle → awaiting-approval (if approve needed) → approving (pending receipt)
     → awaiting-tx (wallet prompt)           → confirming (pending receipt)
     → success (receipt confirmed)
     → error (any rejection or revert — decoded via errors.ts)
```

Rules: never show success before `useWaitForTransactionReceipt` returns `isSuccess`. Decode custom errors from revert data. User rejection resets to idle silently.

### Action Visibility Rules

| Button | Shown when |
|---|---|
| Join | OPEN + deadline not passed + caller has no slot |
| Withdraw | hasDeposited && isRefundable |
| Cancel | creator && OPEN |
| Claim | recipient && FILLED && within CLAIM_WINDOW |

Disable any button when `callerBalance < share + 1.3 × gasEstimate` (in USDC units, since Arc gas is USDC).

---

## 6. P1 API (Vercel functions under `api/`)

### Endpoints

```
GET  /api/healthz
  → 200 { ok: true }

POST /api/v1/pots/:chainId/:potId/metadata
  Body: { title: string, note: string, salt: string }
  → Reads pot from chain (RPC), computes keccak256(abi.encodePacked(title, note, salt))
  → Verifies hash matches pot.metadataHash on-chain
  → Upserts row in Supabase (service-role key, no anonymous write)
  → 201 { ok: true }

GET  /api/v1/pots/:chainId/:potId/metadata
  → Reads row from Supabase (public read via RLS)
  → 200 { title, note } | 404
```

### Supabase Schema

```sql
create table pot_metadata (
  chain_id   bigint      not null,
  pot_id     bigint      not null,
  title      text        not null,
  note       text        not null default '',
  salt       text        not null,       -- stored so hash can be re-verified
  created_at timestamptz not null default now(),
  primary key (chain_id, pot_id)
);

-- RLS
alter table pot_metadata enable row level security;
create policy "public read"  on pot_metadata for select using (true);
create policy "no anon write" on pot_metadata for insert using (false);
create policy "no anon update" on pot_metadata for update using (false);
-- Service-role key bypasses RLS; all writes come from the API function only.
```

---

## 7. Environment Variables

### Public (prefix `VITE_`, shipped to browser)

```
VITE_WALLETCONNECT_PROJECT_ID   WalletConnect Cloud project ID
VITE_ARC_NETWORK                testnet | mainnet  (default: testnet)
VITE_POTLY_ADDRESS              deployed contract address
VITE_TREASURY_ADDRESS           treasury address (for Proof strip link)
VITE_API_BASE_URL               base URL for /api calls (e.g. https://potly.vercel.app)
```

### Server-only (never in browser, Vercel env only)

```
SUPABASE_URL                    Supabase project URL
SUPABASE_SERVICE_ROLE_KEY       Supabase service-role secret
ARC_RPC_URL                     RPC for server-side chain reads
```

---

## 8. Acceptance Criteria by Milestone

### M0 — Contract (deploy to Arc Testnet)
- `forge build` succeeds; all test cases pass; no Critical/High findings from review
- Deployed address recorded in `contracts/contract-metadata/Potly.json`
- `sweepUnaccounted` and `totalLocked` invariant verified by integration test

### M1 — Create & Share
- Wallet connects via ConnectKit on Arc Testnet
- CreatePotForm produces a real on-chain pot (tx confirmed, receipt received)
- `metadataHash` matches `keccak256(abi.encodePacked(title, note, salt))` stored via POST API
- `/p/:chainId/:potId` route renders slot grid, countdown, status badge from live chain data
- Share link (via `buildShareLink`) and QR open the correct pot page

### M2 — Join / Withdraw / Cancel / Claim
- Join: approve + deposit succeeds; slot grid updates after receipt
- Withdraw: USDC returned to caller after confirmed receipt; not callable after PAID
- Cancel: CANCELLED status shown; depositors can then withdraw
- Claim: full payout minus fee received by recipient; PAID status shown
- All action buttons disabled correctly per role and state rules
- Custom errors decoded and shown as human-readable messages

### M3 — My Pots & Proof Strip
- `/my` lists all pots where connected address is creator or depositor (from events)
- ProofStrip shows live `potCount` and total USDC settled (sum of `PayoutClaimed` events)
- Contract and treasury links point to Arc Testnet explorer

### M4 — P1 API
- `GET /api/healthz` returns 200
- POST stores metadata only when on-chain hash matches; rejects mismatches
- GET returns title and note; 404 when not stored
- No Supabase service-role key exposed to browser at any point

---

## 9. Unresolved Decisions

1. **Salt generation**: client-generated random salt (32 bytes, hex) or server-generated? Client is simpler and keeps the server stateless, but the salt must be stored by the user or the POST must be called immediately after `createPot` confirms.
2. **Gas estimate display**: `eth_estimateGas` for `deposit` requires a pre-approved allowance; use a hardcoded fallback (e.g. 120 000 gas) or require approval first?
3. **Contract address delivery**: hardcode `VITE_POTLY_ADDRESS` in `.env`, or read from `contract-metadata/Potly.json` at build time via a Vite plugin? The latter breaks if the metadata file is not committed.
4. **Duration presets**: spec says 5 min / 1 day / 7 days; should a custom duration text input also be offered?
5. **VITE_ARC_NETWORK switch**: a single binary toggle covers testnet/mainnet but not multi-chain. Confirm v1 is Arc-only.
6. **Supabase RLS vs service-role**: the write policy blocks anonymous inserts, but the service-role key in the API function bypasses RLS entirely — any API caller can write. Consider rate-limiting or a nonce on the POST body.
7. **Dark vs light UI**: spec says "mobile-first dark fintech UI"; Arc design defaults are Arc Light (warm canvas). Confirm dark (Arc Dark tokens) for v1.
8. **QR library**: `qrcode.react` is listed in the scaffold; confirm it is already installed or needs adding to `package.json`.
9. **Vercel deployment**: the spec puts API functions under `api/` (Vercel convention); confirm the frontend host is also Vercel (affects `VITE_API_BASE_URL` being empty in production).
10. **`maxPotTotal` constructor arg**: what value should be passed on deploy? (e.g. 10 000 USDC = `10_000_000_000` in 6-decimal units — needs a decision before deployment.)
