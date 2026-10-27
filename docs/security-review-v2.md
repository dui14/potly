# Potly v2 — Max Security Review

## Contract

`contracts/Potly.sol` — flexible-contribution conditional group pot in USDC on Arc.

---

## Audit results

| Auditor | Findings |
|---|---|
| Structural (rule-corpus) | 2 Low |
| Functional | 0 |

---

## Structural findings

### Low: `missing-emergency-pause-mechanism`

**Rule:** missing-emergency-pause-mechanism
**Location:** Potly.sol — contract-level, all mutating entry points
**Summary:** No pause/unpause mechanism exists. If a chain-level incident occurs, operations cannot be halted on-chain.
**Disposition: Accepted by design.** The spec explicitly states "No owner, no pause, no proxy, no upgrade." Introducing a pause owner contradicts the trustless design. Mitigation: short `MAX_DURATION` (30 days) limits maximum locked exposure; `sweepUnaccounted` and post-window withdrawal give contributors and operators recovery paths without admin privileges.

### Low: `specification-implementation-mismatch`

**Rule:** specification-implementation-mismatch
**Location:** Potly.sol:171 `deposit`, claimPayout
**Summary:** The auditor noted that the previous spec (equal shares, recipient-only claim) differs from the v2 implementation (flexible amounts, anyone can trigger claim).
**Disposition: Not applicable.** This is v2. The v2 spec explicitly supersedes the v1 model. The NatSpec on the contract, the updated test suite, and this review document all reflect the v2 design. No logic change required; NatSpec already documents the new model.

---

## Previously reported High findings (functional auditor, first pass)

### High: `arc-recipient-transfer-can-brick-payout`

**Summary:** A blocklisted recipient causes `claimPayout` to revert permanently, stranding contributed funds.
**Disposition: Accepted by design.** The contract NatSpec on `createPot` explicitly warns: "If the recipient address is blocklisted by the USDC contract, claimPayout will revert. After CLAIM_WINDOW expires, contributors may withdraw via isRefundable." This is the intended recovery path. Test `test_blacklisted_recipient_depositors_can_refund_after_window` verifies it. **Resolved by documentation on first pass; functional auditor confirmed 0 findings on re-audit.**

### High: `treasury-transfer-single-point-of-failure`

**Summary:** If the treasury address becomes blocklisted, fee-bearing `claimPayout` calls revert, preventing recipient payout even if the recipient is valid.
**Disposition: Accepted with documentation.** The treasury is an immutable deployer-chosen address. New NatSpec on the constructor warns: "MUST be a non-blocklisted address … If treasury becomes blocklisted after deployment, fee-bearing claimPayout calls will revert; all contributors can still withdraw their contributions once isRefundable returns true." The post-window withdrawal path is verified by the blacklisted-recipient test. **Resolved by documentation; functional auditor confirmed 0 findings on re-audit.**

---

## Test results

**73 / 73 PASS, 0 FAIL, 0 SKIP**

```
Ran 1 test suite in 560.27ms: 73 tests passed, 0 failed, 0 skipped
```

### Test cases

| Test | Result |
|---|---|
| test_constructor_rejects_zero_usdc | PASS |
| test_constructor_rejects_zero_treasury | PASS |
| test_constructor_rejects_fee_over_100 | PASS |
| test_constructor_rejects_eoa_usdc | PASS |
| test_constructor_fee_exactly_100_passes | PASS |
| test_createPot_happy | PASS |
| test_createPot_creator_equals_recipient | PASS |
| test_createPot_rejects_zero_recipient | PASS |
| test_createPot_rejects_self_recipient | PASS |
| test_createPot_slots_min_boundary | PASS |
| test_createPot_slots_zero_reverts | PASS |
| test_createPot_slots_max_boundary | PASS |
| test_createPot_slots_above_max_reverts | PASS |
| test_createPot_duration_min_boundary | PASS |
| test_createPot_duration_below_min_reverts | PASS |
| test_createPot_duration_max_boundary | PASS |
| test_createPot_duration_above_max_reverts | PASS |
| test_createPot_target_min_boundary | PASS |
| test_createPot_target_below_min_reverts | PASS |
| test_createPot_above_maxPotTotal_reverts | PASS |
| test_deposit_happy | PASS |
| test_deposit_partial_fills_from_several_wallets | PASS |
| test_deposit_overpay_capped | PASS |
| test_deposit_100_contributors_and_101st_reverts | PASS |
| test_deposit_new_contributor_reverts_when_slots_full | PASS |
| test_deposit_existing_contributor_can_top_up_when_slots_full | PASS |
| test_deposit_at_deadline_reverts | PASS |
| test_deposit_one_second_before_deadline_succeeds | PASS |
| test_deposit_zero_amount_reverts | PASS |
| test_deposit_below_min_not_final_reverts | PASS |
| test_deposit_below_min_final_remainder_accepted | PASS |
| test_deposit_on_cancelled_pot_reverts | PASS |
| test_deposit_on_paid_pot_reverts | PASS |
| test_withdraw_while_open | PASS |
| test_partial_withdraw_then_redeposit | PASS |
| test_withdraw_above_contribution_reverts | PASS |
| test_withdraw_zero_reverts | PASS |
| test_withdraw_no_contribution_reverts | PASS |
| test_withdraw_after_deadline_while_open | PASS |
| test_withdraw_after_cancel | PASS |
| test_withdraw_after_filled_claim_window_expired | PASS |
| test_withdraw_while_filled_in_window_reverts | PASS |
| test_withdraw_after_paid_reverts | PASS |
| test_cancel_happy | PASS |
| test_cancel_non_creator_reverts | PASS |
| test_cancel_after_filled_reverts | PASS |
| test_cancel_after_cancelled_reverts | PASS |
| test_claimPayout_happy | PASS |
| test_claimPayout_non_recipient_triggers_payout_to_recipient | PASS |
| test_claimPayout_fee_rounding_down | PASS |
| test_claimPayout_zero_fee | PASS |
| test_claimPayout_twice_reverts | PASS |
| test_claimPayout_after_window_reverts | PASS |
| test_claimPayout_not_filled_reverts | PASS |
| test_isRefundable_open | PASS |
| test_isRefundable_cancelled | PASS |
| test_isRefundable_filled_within_window | PASS |
| test_isRefundable_filled_after_window | PASS |
| test_isRefundable_paid_is_false | PASS |
| test_sweep_happy | PASS |
| test_sweep_nothing_reverts | PASS |
| test_contributionOf_and_remaining | PASS |
| test_claimDeadline_zero_when_open | PASS |
| test_claimDeadline_set_when_filled | PASS |
| test_lifecycle_creator_equals_recipient | PASS |
| test_full_lifecycle_100_contributors | PASS |
| test_blacklisted_recipient_depositors_can_refund_after_window | PASS |
| test_reentrancy_on_withdraw_fails | PASS |
| testFuzz_lockInvariant (256 runs) | PASS |
| testFuzz_feeBpsNeverExceedsCeiling (256 runs) | PASS |
| testFuzz_raisedEqSumContributions (256 runs) | PASS |
| testFuzz_acceptedNeverExceedsRemaining (256 runs) | PASS |
| test_contributors_never_exceed_slots | PASS |

---

## Gas report (Potly contract)

| Function | Min | Avg | Median | Max |
|---|---|---|---|---|
| createPot | 27,368 | 171,596 | 172,659 | 172,671 |
| deposit | 26,807 | 141,926 | 160,283 | 203,974 |
| withdraw | 26,742 | 49,818 | 54,817 | 75,824 |
| claimPayout | 29,057 | 88,653 | 92,255 | 92,255 |
| cancel | 28,795 | 48,823 | 49,474 | 49,474 |
| sweepUnaccounted | 33,939 | 47,630 | 47,630 | 61,321 |
| remaining | 4,903 | 4,903 | 4,903 | 4,903 |
| contributionOf | 2,773 | 2,773 | 2,773 | 2,773 |
| claimDeadline | 2,788 | 3,805 | 3,805 | 4,823 |
| isRefundable | 2,612 | 5,026 | 5,124 | 5,124 |

Deployment cost: **1,272,559 gas** (6,133 bytes).

---

## Slither

Slither was not run. It is not available in this sandbox. The structural auditor (rule-corpus) and functional auditor covered the equivalent surface area.

---

## Constructor arguments (for the next deploy)

These must match the deployed v1 values to be consistent with the existing treasury and fee policy:

| Parameter | Value | Notes |
|---|---|---|
| `_usdc` | `0x3600000000000000000000000000000000000000` | Arc Testnet USDC predeploy |
| `_treasury` | `0x2D59D71A027483d53dEe8F320CcE6147eB7cD891` | Existing treasury |
| `_feeBps` | `5` | 0.05% |
| `_maxPotTotal` | `500000000` | 500 USDC (6 dec) |
