Potly — a conditional group pot in USDC on Arc. N people each deposit an equal share; if every slot is filled before the deadline the recipient claims the money; otherwise every depositor takes back their own share. Nobody fronts money and the contract never keeps funds after a pot ends.

CONTRACT Potly.sol (Smart Contract mode, Solidity 0.8.28, OpenZeppelin 5; no owner, no pause, no proxy, no upgrade)
Constructor: (address usdc, address treasury, uint16 feeBps, uint256 maxPotTotal). Reject zero addresses, usdc without code, feeBps > 100. Constants: MIN_SLOTS 2, MAX_SLOTS 20, MIN_SHARE 10_000 (0.01 USDC), MIN_DURATION 60 s, MAX_DURATION 30 days, CLAIM_WINDOW 7 days.
Pot: creator, recipient, share, slots, filled, deadline, filledAt, status (OPEN, FILLED, PAID, CANCELLED), metadataHash (bytes32). Per pot, a wallet may hold at most one slot.
Functions (all nonReentrant, checks-effects-interactions):
- createPot(recipient, share, slots, durationSeconds, metadataHash) -> potId. Reject recipient == 0 or == this contract; slots and duration within limits; share >= MIN_SHARE; share*slots <= maxPotTotal. The recipient may equal the creator. The creator pays only gas.
- deposit(potId): OPEN, before the deadline, caller holds no slot. Pulls exactly `share` with transferFrom. The deposit that fills the last slot sets FILLED and filledAt.
- withdraw(potId): returns the caller's own share. Allowed while OPEN (before or after the deadline), when CANCELLED, or when FILLED and filledAt + CLAIM_WINDOW has passed. Never when PAID.
- cancel(potId): creator only, only while OPEN. Sets CANCELLED; depositors then withdraw themselves.
- claimPayout(potId): recipient only, FILLED, within CLAIM_WINDOW. Sets PAID first, then sends fee = total * feeBps / 10000 (rounded down) to the treasury and total - fee to the recipient in the same transaction. The fee is charged only on success; refunds are always 100% of the deposit.
- sweepUnaccounted(): anyone; sends (USDC balance - totalLocked) to the treasury if positive (covers tokens sent directly to the contract).
- Views: getPot, hasDeposited, claimDeadline, isRefundable, potCount, totalLocked.
- Custom errors for every rejection; events PotCreated, Deposited, PotFilled, Withdrawn, PotCancelled, PayoutClaimed, Swept.
Invariants for tests: USDC balance of the contract == totalLocked (absent direct transfers); locked funds of a pot are 0 after PAID or after all refunds; PAID is terminal; filled <= slots; claimPayout cannot run twice; no refund after PAID; fee never exceeds total * feeBps / 10000; fuzz share, slots, fee rounding and state transitions; blacklisted-recipient case ends with refunds after the claim window; reentrancy attempt fails.

APP (Build mode): mobile-first dark fintech UI, a plain wallet connect (no Privy in v1).
- Create form: recipient, share, slots, duration presets (5 minutes, 1 day, 7 days), title and note (stored off-chain, hash on-chain). Show total, fee note ("0.05% only when paid out") and a gas estimate from live RPC data.
- Pot page /p/<chainId>/<potId>: slot grid, countdown, status badge, share link and QR. Buttons by role: Join (approve exact share, then deposit), Withdraw, Cancel (creator), Claim (recipient). Disable actions without enough balance for share + 1.3x estimated gas.
- My pots list, and a read-only Proof strip (pots, USDC settled, contract and treasury links).
- Real transaction states only; success only after a confirmed receipt; decode custom errors; one env switch VITE_ARC_NETWORK=testnet|mainnet.

API (P1, Vercel functions under api/): GET /api/healthz, POST and GET /api/v1/pots/:chainId/:potId/metadata. The server re-reads the pot from the chain, recomputes the hash, then stores title, note and salt in Supabase (service-role key only in the host environment; RLS allows public read and no anonymous write).
Out of scope for v1: Privy, Supabase Auth, unequal splits, fiat/VND conversion, multi-pot batches, relayers, upgrades.

DECISIONS (override the plan where they differ)
- Metadata hash = keccak256(abi.encode(string title, string note, bytes32 salt)); salt is a client-generated random bytes32; title <= 80 chars, note <= 280; the API inserts once and ignores conflicts.
- Supabase RLS: public read only. Do not create insert/update/delete policies (service role bypasses RLS).
- isRefundable(potId) is true when status != PAID and (status == OPEN, or CANCELLED, or FILLED and now > filledAt + CLAIM_WINDOW). The Withdraw button shows when the caller has deposited and isRefundable is true.
- maxPotTotal = 500_000_000 (500 USDC) on both networks. Contract address comes from VITE_POTLY_ADDRESS; the ABI is copied into src as a constant.
- Duration presets only: 5 minutes, 1 day, 7 days. Arc only; dark UI. The app must work fully without the API (pot titles fall back to "Pot #id").
- Gas estimate: per-action gas constants in one config file times live fee data (estimateFeesPerGas) times 1.3; refine with estimateGas once the allowance exists.
- Follow ai-context/arc-facts.md for chains, RPC lists (fallback transport) and explicit chain definitions.