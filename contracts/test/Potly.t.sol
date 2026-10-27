// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import "../Potly.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ── Minimal mock ERC-20 ────────────────────────────────────────────────────────
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

// ── Reentrant mock for reentrancy tests ────────────────────────────────────────
interface IPotlyV2 {
    function withdraw(uint256 potId, uint256 amount) external;
    function deposit(uint256 potId, uint256 amount) external;
}

contract ReentrantToken is ERC20 {
    address public target;
    uint256 public attackPotId;
    uint256 public attackAmount;
    bool    public attackWithdraw;
    bool    private _armed;

    constructor() ERC20("Reentrant", "RENT") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }

    function arm(address _target, uint256 _potId, uint256 _amount, bool _isWithdraw) external {
        target = _target; attackPotId = _potId; attackAmount = _amount;
        attackWithdraw = _isWithdraw; _armed = true;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (_armed && from != address(0) && to != address(0) && to != target) {
            _armed = false;
            if (attackWithdraw) {
                try IPotlyV2(target).withdraw(attackPotId, attackAmount) { } catch { }
            } else {
                try IPotlyV2(target).deposit(attackPotId, attackAmount) { } catch { }
            }
        }
    }
}

// ── Main test contract ─────────────────────────────────────────────────────────
contract PotlyTest is Test {
    MockUSDC usdc;
    Potly    potly;
    address  treasury;

    uint16  constant FEE_BPS     = 5;           // 0.05 %
    uint256 constant MAX_TOTAL   = 500_000_000; // 500 USDC
    uint256 constant TARGET      = 30_000_000;  // 30 USDC
    uint256 constant CHUNK       = 10_000_000;  // 10 USDC
    uint256 constant DURATION    = 1 days;
    uint256 constant MIN_CONTRIB = 10_000;      // mirror of Potly.MIN_CONTRIB

    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave  = makeAddr("dave");
    address eve   = makeAddr("eve");

    function setUp() public {
        treasury = makeAddr("treasury");
        usdc     = new MockUSDC();
        potly    = new Potly(address(usdc), treasury, FEE_BPS, MAX_TOTAL);

        address[5] memory users = [alice, bob, carol, dave, eve];
        for (uint256 i; i < 5; i++) {
            usdc.mint(users[i], 1_000_000_000); // 1000 USDC
            vm.prank(users[i]);
            usdc.approve(address(potly), type(uint256).max);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Create a pot with `target` and `slots=3` unless overridden.
    function _create(address creator, address recip, uint256 target_, uint256 slots_, uint256 dur)
        internal returns (uint256 id)
    {
        vm.prank(creator);
        id = potly.createPot(recip, target_, slots_, dur, bytes32(0));
    }

    function _deposit(address who, uint256 id, uint256 amount) internal {
        vm.prank(who);
        potly.deposit(id, amount);
    }

    function _withdraw(address who, uint256 id, uint256 amount) internal {
        vm.prank(who);
        potly.withdraw(id, amount);
    }

    function _assertLockInvariant() internal view {
        assertEq(usdc.balanceOf(address(potly)), potly.totalLocked(),
                 "invariant: balance != totalLocked");
    }

    function _assertRaisedEqSumContributions(uint256 id, address[] memory contributors_) internal view {
        uint256 sum;
        for (uint256 i; i < contributors_.length; i++)
            sum += potly.contributionOf(id, contributors_[i]);
        assertEq(potly.getPot(id).raised, sum, "invariant: raised != sum(contributions)");
    }

    // ── Constructor validation ────────────────────────────────────────────────

    function test_constructor_rejects_zero_usdc() public {
        vm.expectRevert(Potly.ZeroAddress.selector);
        new Potly(address(0), treasury, FEE_BPS, MAX_TOTAL);
    }

    function test_constructor_rejects_zero_treasury() public {
        vm.expectRevert(Potly.ZeroAddress.selector);
        new Potly(address(usdc), address(0), FEE_BPS, MAX_TOTAL);
    }

    function test_constructor_rejects_fee_over_100() public {
        vm.expectRevert(abi.encodeWithSelector(Potly.FeeTooHigh.selector, uint16(101)));
        new Potly(address(usdc), treasury, 101, MAX_TOTAL);
    }

    function test_constructor_rejects_eoa_usdc() public {
        vm.expectRevert(abi.encodeWithSelector(Potly.NoCode.selector, alice));
        new Potly(alice, treasury, FEE_BPS, MAX_TOTAL);
    }

    function test_constructor_fee_exactly_100_passes() public {
        Potly p = new Potly(address(usdc), treasury, 100, MAX_TOTAL);
        assertEq(p.feeBps(), 100);
    }

    // ── createPot validation ──────────────────────────────────────────────────

    function test_createPot_happy() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        assertEq(id, 0);
        Potly.Pot memory p = potly.getPot(id);
        assertEq(p.creator,   alice);
        assertEq(p.recipient, bob);
        assertEq(p.target,    TARGET);
        assertEq(p.slots,     3);
        assertEq(p.raised,    0);
        assertEq(uint8(p.status), uint8(Potly.Status.OPEN));
    }

    function test_createPot_creator_equals_recipient() public {
        uint256 id = _create(alice, alice, TARGET, 1, DURATION);
        Potly.Pot memory p = potly.getPot(id);
        assertEq(p.creator, alice);
        assertEq(p.recipient, alice);
    }

    function test_createPot_rejects_zero_recipient() public {
        vm.prank(alice);
        vm.expectRevert(Potly.InvalidRecipient.selector);
        potly.createPot(address(0), TARGET, 1, DURATION, bytes32(0));
    }

    function test_createPot_rejects_self_recipient() public {
        vm.prank(alice);
        vm.expectRevert(Potly.InvalidRecipient.selector);
        potly.createPot(address(potly), TARGET, 1, DURATION, bytes32(0));
    }

    // MIN/MAX boundaries — slots (1..100)
    function test_createPot_slots_min_boundary() public {
        _create(alice, bob, TARGET, 1, DURATION);
    }

    function test_createPot_slots_zero_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Potly.InvalidSlots.selector, uint256(0)));
        potly.createPot(bob, TARGET, 0, DURATION, bytes32(0));
    }

    function test_createPot_slots_max_boundary() public {
        _create(alice, bob, TARGET, 100, DURATION);
    }

    function test_createPot_slots_above_max_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Potly.InvalidSlots.selector, uint256(101)));
        potly.createPot(bob, TARGET, 101, DURATION, bytes32(0));
    }

    // Duration boundaries
    function test_createPot_duration_min_boundary() public {
        _create(alice, bob, TARGET, 1, 60);
    }

    function test_createPot_duration_below_min_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Potly.InvalidDuration.selector, uint256(59)));
        potly.createPot(bob, TARGET, 1, 59, bytes32(0));
    }

    function test_createPot_duration_max_boundary() public {
        _create(alice, bob, TARGET, 1, 30 days);
    }

    function test_createPot_duration_above_max_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Potly.InvalidDuration.selector, 30 days + 1));
        potly.createPot(bob, TARGET, 1, 30 days + 1, bytes32(0));
    }

    // Target boundaries
    function test_createPot_target_min_boundary() public {
        _create(alice, bob, 10_000, 1, DURATION);
    }

    function test_createPot_target_below_min_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Potly.TargetTooSmall.selector, uint256(9_999)));
        potly.createPot(bob, 9_999, 1, DURATION, bytes32(0));
    }

    function test_createPot_above_maxPotTotal_reverts() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Potly.TargetExceedsMax.selector, uint256(MAX_TOTAL + 1), uint256(MAX_TOTAL))
        );
        potly.createPot(bob, MAX_TOTAL + 1, 1, DURATION, bytes32(0));
    }

    // ── deposit ───────────────────────────────────────────────────────────────

    function test_deposit_happy() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        uint256 before_ = usdc.balanceOf(alice);
        _deposit(alice, id, CHUNK);
        assertEq(usdc.balanceOf(alice), before_ - CHUNK);
        assertEq(usdc.balanceOf(address(potly)), CHUNK);
        assertEq(potly.totalLocked(), CHUNK);
        assertEq(potly.contributionOf(id, alice), CHUNK);
        assertEq(potly.getPot(id).raised, CHUNK);
        assertEq(potly.getPot(id).contributors, 1);
        _assertLockInvariant();
    }

    function test_deposit_partial_fills_from_several_wallets() public {
        uint256 id = _create(alice, bob, TARGET, 5, DURATION);
        _deposit(alice, id, CHUNK);   // 10 USDC
        _deposit(bob,   id, CHUNK);   // 10 USDC
        _deposit(carol, id, CHUNK);   // 10 USDC  → raised == target → FILLED

        Potly.Pot memory p = potly.getPot(id);
        assertEq(uint8(p.status), uint8(Potly.Status.FILLED));
        assertEq(p.raised, TARGET);
        assertEq(p.contributors, 3);
        _assertLockInvariant();

        address[] memory cs = new address[](3);
        cs[0] = alice; cs[1] = bob; cs[2] = carol;
        _assertRaisedEqSumContributions(id, cs);
    }

    function test_deposit_overpay_capped() public {
        // target=10 USDC, remaining=4 USDC, deposit=15 → only 4 pulled
        uint256 target_ = 10_000_000; // 10 USDC
        uint256 id = _create(alice, bob, target_, 3, DURATION);
        _deposit(alice, id, 6_000_000);   // 6 USDC → remaining = 4

        uint256 aliceBefore = usdc.balanceOf(alice);
        _deposit(alice, id, 15_000_000);  // overpay: only 4 accepted (alice re-deposits)

        uint256 accepted = 4_000_000;
        assertEq(usdc.balanceOf(alice), aliceBefore - accepted,
                 "overpay: caller should only lose the remaining amount");
        assertEq(potly.getPot(id).raised, target_);
        assertEq(uint8(potly.getPot(id).status), uint8(Potly.Status.FILLED));
        _assertLockInvariant();
    }

    function test_deposit_100_contributors_and_101st_reverts() public {
        // 100 contributors × 5 USDC = 500 USDC = MAX_TOTAL exactly
        uint256 perContrib = 5_000_000; // 5 USDC
        uint256 target_ = 100 * perContrib; // 500 USDC = MAX_TOTAL
        uint256 id = _create(alice, bob, target_, 100, DURATION);

        for (uint256 i; i < 100; i++) {
            address c = makeAddr(string(abi.encodePacked("c100_", i)));
            usdc.mint(c, perContrib);
            vm.prank(c);
            usdc.approve(address(potly), type(uint256).max);
            vm.prank(c);
            potly.deposit(id, perContrib);
        }
        // pot is now FILLED (100 * perContrib == target)
        assertEq(uint8(potly.getPot(id).status), uint8(Potly.Status.FILLED));

        // 101st contributor: pot is full
        address extra = makeAddr("extra101");
        usdc.mint(extra, CHUNK);
        vm.prank(extra);
        usdc.approve(address(potly), type(uint256).max);
        vm.prank(extra);
        vm.expectRevert(); // PotFull or PotNotOpen (FILLED)
        potly.deposit(id, CHUNK);
        _assertLockInvariant();
    }

    function test_deposit_new_contributor_reverts_when_slots_full() public {
        // 2-slot pot, 2 contributors have taken the slots but pot target is large
        uint256 target_ = 300_000_000; // 300 USDC
        uint256 id = _create(alice, bob, target_, 2, DURATION);
        _deposit(alice, id, CHUNK); // slot 1
        _deposit(carol, id, CHUNK); // slot 2 — all 2 slots used, pot still OPEN (raised < target)

        // dave tries to join — no free slot
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(Potly.PotFull.selector, id));
        potly.deposit(id, CHUNK);
    }

    function test_deposit_existing_contributor_can_top_up_when_slots_full() public {
        // Same scenario: alice fills the last slot as a contributor, but can still add to her own
        uint256 target_ = 40_000_000; // 40 USDC
        uint256 id = _create(alice, bob, target_, 2, DURATION);
        _deposit(alice, id, CHUNK); // 10 USDC
        _deposit(carol, id, CHUNK); // 10 USDC — 2 slots used

        // alice top-up (existing contributor, not new)
        _deposit(alice, id, CHUNK); // 10 USDC more
        assertEq(potly.contributionOf(id, alice), CHUNK * 2);
        assertEq(potly.getPot(id).contributors, 2); // still 2 distinct contributors
        _assertLockInvariant();
    }

    function test_deposit_at_deadline_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        vm.warp(block.timestamp + DURATION);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Potly.DeadlinePassed.selector, id, block.timestamp));
        potly.deposit(id, CHUNK);
    }

    function test_deposit_one_second_before_deadline_succeeds() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        vm.warp(block.timestamp + DURATION - 1);
        _deposit(alice, id, CHUNK);
    }

    function test_deposit_zero_amount_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        vm.prank(alice);
        vm.expectRevert(Potly.ZeroAmount.selector);
        potly.deposit(id, 0);
    }

    function test_deposit_below_min_not_final_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        vm.prank(alice);
        vm.expectRevert(); // AmountBelowMin
        potly.deposit(id, 9_999); // < MIN_CONTRIB and not final remainder
    }

    function test_deposit_below_min_final_remainder_accepted() public {
        // Arrange: pot target=10.009 USDC; alice puts in 10 USDC → remaining=9,000 (< MIN)
        uint256 target_ = 10_009_000; // 10.009 USDC
        uint256 id = _create(alice, bob, target_, 2, DURATION);
        _deposit(alice, id, 10_000_000); // remaining = 9_000 < MIN_CONTRIB

        // bob deposits exactly the remaining amount — accepted because it IS the remainder
        uint256 bobBefore = usdc.balanceOf(bob);
        _deposit(bob, id, 9_000);
        assertEq(usdc.balanceOf(bob), bobBefore - 9_000);
        assertEq(uint8(potly.getPot(id).status), uint8(Potly.Status.FILLED));
        _assertLockInvariant();
    }

    function test_deposit_on_cancelled_pot_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        vm.prank(alice); potly.cancel(id);
        vm.prank(bob);
        vm.expectRevert();
        potly.deposit(id, CHUNK);
    }

    function test_deposit_on_paid_pot_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK); // FILLED
        potly.claimPayout(id);      // PAID (anyone can trigger)
        vm.prank(eve);
        vm.expectRevert();
        potly.deposit(id, CHUNK);
    }

    // ── withdraw ──────────────────────────────────────────────────────────────

    function test_withdraw_while_open() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        uint256 before_ = usdc.balanceOf(alice);
        _withdraw(alice, id, CHUNK);
        assertEq(usdc.balanceOf(alice), before_ + CHUNK);
        assertEq(potly.contributionOf(id, alice), 0);
        assertEq(potly.getPot(id).raised, 0);
        assertEq(potly.getPot(id).contributors, 0);
        assertEq(potly.totalLocked(), 0);
        _assertLockInvariant();
    }

    function test_partial_withdraw_then_redeposit() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK * 2);       // 20 USDC
        _withdraw(alice, id, CHUNK);          // withdraw 10 USDC → remaining contribution = 10

        assertEq(potly.contributionOf(id, alice), CHUNK);
        assertEq(potly.getPot(id).contributors, 1); // still has a contribution

        _deposit(alice, id, CHUNK);           // top back up → contribution = 20 again
        assertEq(potly.contributionOf(id, alice), CHUNK * 2);
        _assertLockInvariant();
    }

    function test_withdraw_above_contribution_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Potly.AmountExceedsContribution.selector, CHUNK + 1, CHUNK)
        );
        potly.withdraw(id, CHUNK + 1);
    }

    function test_withdraw_zero_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        vm.prank(alice);
        vm.expectRevert(Potly.ZeroAmount.selector);
        potly.withdraw(id, 0);
    }

    function test_withdraw_no_contribution_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Potly.NoContribution.selector, id, bob));
        potly.withdraw(id, CHUNK);
    }

    function test_withdraw_after_deadline_while_open() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        vm.warp(block.timestamp + DURATION + 1);
        _withdraw(alice, id, CHUNK);
        _assertLockInvariant();
    }

    function test_withdraw_after_cancel() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        vm.prank(alice); potly.cancel(id);
        _withdraw(alice, id, CHUNK);
        _assertLockInvariant();
    }

    function test_withdraw_after_filled_claim_window_expired() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK); // FILLED
        vm.warp(block.timestamp + 7 days + 1);
        _withdraw(alice, id, CHUNK);
        _assertLockInvariant();
    }

    function test_withdraw_while_filled_in_window_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK); // FILLED
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Potly.NotRefundable.selector, id));
        potly.withdraw(id, CHUNK);
    }

    function test_withdraw_after_paid_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK); // FILLED
        potly.claimPayout(id);      // PAID
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Potly.NotRefundable.selector, id));
        potly.withdraw(id, CHUNK);
    }

    // ── cancel ────────────────────────────────────────────────────────────────

    function test_cancel_happy() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        vm.prank(alice); potly.cancel(id);
        assertEq(uint8(potly.getPot(id).status), uint8(Potly.Status.CANCELLED));
    }

    function test_cancel_non_creator_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Potly.NotCreator.selector, id, bob));
        potly.cancel(id);
    }

    function test_cancel_after_filled_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK); // FILLED
        vm.prank(alice);
        vm.expectRevert(); // PotNotOpen
        potly.cancel(id);
    }

    function test_cancel_after_cancelled_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        vm.prank(alice); potly.cancel(id);
        vm.prank(alice);
        vm.expectRevert();
        potly.cancel(id);
    }

    // ── claimPayout ───────────────────────────────────────────────────────────

    function test_claimPayout_happy() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK); // FILLED

        uint256 total  = TARGET;
        uint256 fee    = (total * FEE_BPS) / 10_000;
        uint256 payout = total - fee;

        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 tBefore   = usdc.balanceOf(treasury);

        potly.claimPayout(id); // callable by ANYONE

        assertEq(usdc.balanceOf(bob),      bobBefore + payout);
        assertEq(usdc.balanceOf(treasury), tBefore   + fee);
        assertEq(uint8(potly.getPot(id).status), uint8(Potly.Status.PAID));
        assertEq(potly.totalLocked(), 0);
        _assertLockInvariant();
    }

    function test_claimPayout_non_recipient_triggers_payout_to_recipient() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK); // FILLED

        uint256 total  = TARGET;
        uint256 fee    = (total * FEE_BPS) / 10_000;
        uint256 payout = total - fee;

        uint256 bobBefore     = usdc.balanceOf(bob);
        uint256 aliceBefore   = usdc.balanceOf(alice);
        uint256 tBefore       = usdc.balanceOf(treasury);

        // dave (not the recipient) triggers claimPayout
        vm.prank(dave);
        potly.claimPayout(id);

        // bob (recipient) received the payout
        assertEq(usdc.balanceOf(bob), bobBefore + payout);
        // treasury received the fee
        assertEq(usdc.balanceOf(treasury), tBefore + fee);
        // dave received nothing extra
        assertEq(usdc.balanceOf(alice), aliceBefore);
        // dave did not receive anything either
        assertEq(uint8(potly.getPot(id).status), uint8(Potly.Status.PAID));
        _assertLockInvariant();
    }

    function test_claimPayout_fee_rounding_down() public {
        // target=30_003, feeBps=5: fee=30003*5/10000=15 (floor, not 15.0015)
        uint256 id = _create(alice, bob, 30_003, 3, DURATION);
        _deposit(alice, id, 10_001);
        _deposit(carol, id, 10_001);
        _deposit(dave,  id, 10_001);
        uint256 fee = (30_003 * uint256(FEE_BPS)) / 10_000;
        uint256 tBefore = usdc.balanceOf(treasury);
        potly.claimPayout(id);
        assertEq(usdc.balanceOf(treasury), tBefore + fee);
    }

    function test_claimPayout_zero_fee() public {
        Potly p0 = new Potly(address(usdc), treasury, 0, MAX_TOTAL);
        usdc.mint(alice, CHUNK * 3);
        vm.startPrank(alice);
        usdc.approve(address(p0), type(uint256).max);
        uint256 id = p0.createPot(bob, CHUNK, 1, DURATION, bytes32(0));
        p0.deposit(id, CHUNK); // FILLED (single contributor, exactly target)
        vm.stopPrank();
        uint256 bobBefore = usdc.balanceOf(bob);
        p0.claimPayout(id);
        assertEq(usdc.balanceOf(bob), bobBefore + CHUNK);
    }

    function test_claimPayout_twice_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK);
        potly.claimPayout(id);
        vm.expectRevert(); // PotNotFilled (status == PAID)
        potly.claimPayout(id);
    }

    function test_claimPayout_after_window_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK);
        vm.warp(block.timestamp + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(Potly.ClaimWindowClosed.selector, id));
        potly.claimPayout(id);
    }

    function test_claimPayout_not_filled_reverts() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        vm.expectRevert(); // PotNotFilled
        potly.claimPayout(id);
    }

    // ── isRefundable ──────────────────────────────────────────────────────────

    function test_isRefundable_open() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        assertTrue(potly.isRefundable(id));
    }

    function test_isRefundable_cancelled() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        vm.prank(alice); potly.cancel(id);
        assertTrue(potly.isRefundable(id));
    }

    function test_isRefundable_filled_within_window() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK);
        assertFalse(potly.isRefundable(id));
    }

    function test_isRefundable_filled_after_window() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK);
        vm.warp(block.timestamp + 7 days + 1);
        assertTrue(potly.isRefundable(id));
    }

    function test_isRefundable_paid_is_false() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK);
        potly.claimPayout(id);
        assertFalse(potly.isRefundable(id));
    }

    // ── sweepUnaccounted ──────────────────────────────────────────────────────

    function test_sweep_happy() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        usdc.mint(address(potly), 5_000_000);
        uint256 tBefore = usdc.balanceOf(treasury);
        potly.sweepUnaccounted();
        assertEq(usdc.balanceOf(treasury), tBefore + 5_000_000);
        _assertLockInvariant();
    }

    function test_sweep_nothing_reverts() public {
        vm.expectRevert(Potly.NothingToSweep.selector);
        potly.sweepUnaccounted();
    }

    // ── Views: contributionOf, remaining, claimDeadline ───────────────────────

    function test_contributionOf_and_remaining() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        assertEq(potly.contributionOf(id, alice), 0);
        assertEq(potly.remaining(id), TARGET);
        _deposit(alice, id, CHUNK);
        assertEq(potly.contributionOf(id, alice), CHUNK);
        assertEq(potly.remaining(id), TARGET - CHUNK);
    }

    function test_claimDeadline_zero_when_open() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        assertEq(potly.claimDeadline(id), 0);
    }

    function test_claimDeadline_set_when_filled() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        uint256 ts = block.timestamp;
        _deposit(dave,  id, CHUNK); // fills
        assertEq(potly.claimDeadline(id), ts + 7 days);
    }

    // ── Lifecycle: creator == recipient ───────────────────────────────────────

    function test_lifecycle_creator_equals_recipient() public {
        uint256 id = _create(alice, alice, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(bob,   id, CHUNK);
        _deposit(carol, id, CHUNK); // FILLED
        potly.claimPayout(id);
        assertEq(uint8(potly.getPot(id).status), uint8(Potly.Status.PAID));
        _assertLockInvariant();
    }

    // ── Full lifecycle: 100 contributors ─────────────────────────────────────

    function test_full_lifecycle_100_contributors() public {
        uint256 perContrib = 5_000_000; // 5 USDC
        uint256 target_    = 100 * perContrib; // 500 USDC = MAX_TOTAL
        address recip      = makeAddr("recip100");
        uint256 id         = _create(alice, recip, target_, 100, DURATION);

        for (uint256 i; i < 100; i++) {
            address c = makeAddr(string(abi.encodePacked("life100_", i)));
            usdc.mint(c, perContrib);
            vm.prank(c);
            usdc.approve(address(potly), type(uint256).max);
            vm.prank(c);
            potly.deposit(id, perContrib);
        }

        Potly.Pot memory p = potly.getPot(id);
        assertEq(uint8(p.status), uint8(Potly.Status.FILLED));
        assertEq(p.raised, target_);
        assertEq(p.contributors, 100);
        _assertLockInvariant();

        uint256 fee = (target_ * uint256(FEE_BPS)) / 10_000;
        potly.claimPayout(id);
        assertEq(usdc.balanceOf(recip), target_ - fee);
        assertEq(potly.totalLocked(), 0);
        _assertLockInvariant();
    }

    // ── Blacklisted-recipient: depositors refund after window ─────────────────

    function test_blacklisted_recipient_depositors_can_refund_after_window() public {
        uint256 id = _create(alice, bob, TARGET, 3, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        _deposit(dave,  id, CHUNK); // FILLED
        vm.warp(block.timestamp + 7 days + 1);
        assertTrue(potly.isRefundable(id));
        _withdraw(alice, id, CHUNK);
        _withdraw(carol, id, CHUNK);
        _withdraw(dave,  id, CHUNK);
        assertEq(potly.totalLocked(), 0);
        _assertLockInvariant();
    }

    // ── Reentrancy ────────────────────────────────────────────────────────────

    function test_reentrancy_on_withdraw_fails() public {
        ReentrantToken badToken = new ReentrantToken();
        Potly badPotly = new Potly(address(badToken), treasury, FEE_BPS, MAX_TOTAL);

        address attacker = makeAddr("attacker");
        badToken.mint(attacker, CHUNK * 3);
        vm.prank(attacker);
        badToken.approve(address(badPotly), type(uint256).max);

        badToken.mint(alice, CHUNK);
        vm.prank(alice);
        badToken.approve(address(badPotly), type(uint256).max);

        vm.prank(alice);
        uint256 id = badPotly.createPot(bob, TARGET, 3, DURATION, bytes32(0));
        vm.prank(alice);   badPotly.deposit(id, CHUNK);
        vm.prank(attacker); badPotly.deposit(id, CHUNK);
        // fill pot: need one more contributor
        address other = makeAddr("other");
        badToken.mint(other, CHUNK);
        vm.prank(other);
        badToken.approve(address(badPotly), type(uint256).max);
        vm.prank(other);
        badPotly.deposit(id, CHUNK); // FILLED

        badToken.arm(address(badPotly), id, CHUNK, true);
        vm.warp(block.timestamp + 7 days + 1);

        vm.prank(attacker);
        try badPotly.withdraw(id, CHUNK) { } catch { }

        uint256 bal    = badToken.balanceOf(address(badPotly));
        uint256 locked = badPotly.totalLocked();
        assertGe(bal, locked, "reentrancy: balance < totalLocked");
    }

    // ── Fuzz: balance == totalLocked after random deposit/withdraw/cancel/claim ─

    function testFuzz_lockInvariant(
        uint8  rawSlots,
        uint32 rawTarget,
        uint8  rawActions
    ) public {
        uint256 slots_  = bound(uint256(rawSlots),   1, 5);
        uint256 target_ = bound(uint256(rawTarget),  MIN_CONTRIB, 5_000_000);
        if (target_ > MAX_TOTAL) target_ = MAX_TOTAL;
        uint256 chunk_  = target_ / slots_; // each actor deposits this much
        if (chunk_ < MIN_CONTRIB) chunk_ = MIN_CONTRIB;
        if (chunk_ * slots_ > MAX_TOTAL) target_ = chunk_ * slots_;
        if (target_ > MAX_TOTAL) { chunk_ = MAX_TOTAL / slots_; target_ = chunk_ * slots_; }

        address recip = makeAddr("fRecip");
        uint256 id = _create(alice, recip, target_, slots_, DURATION);

        address[] memory actors = new address[](slots_);
        for (uint256 i; i < slots_; i++) {
            actors[i] = makeAddr(string(abi.encodePacked("fActor", i)));
            usdc.mint(actors[i], chunk_ * 4);
            vm.prank(actors[i]);
            usdc.approve(address(potly), type(uint256).max);
        }

        uint256 actions = bound(uint256(rawActions), 0, 10);
        for (uint256 a; a < actions; a++) {
            Potly.Status status = potly.getPot(id).status;
            if (status == Potly.Status.PAID || status == Potly.Status.CANCELLED) break;

            address actor = actors[a % slots_];
            uint256 contrib = potly.contributionOf(id, actor);

            if (a % 4 == 0 && status == Potly.Status.OPEN) {
                // Try to deposit
                vm.prank(actor);
                try potly.deposit(id, chunk_) { } catch { }
            } else if (a % 4 == 1 && contrib > 0 && potly.isRefundable(id)) {
                // Try to withdraw half
                uint256 half = contrib / 2 == 0 ? contrib : contrib / 2;
                vm.prank(actor);
                try potly.withdraw(id, half) { } catch { }
            } else if (a % 4 == 2 && status == Potly.Status.OPEN) {
                // Creator cancel attempt
                vm.prank(alice);
                try potly.cancel(id) { } catch { }
            } else if (a % 4 == 3 && status == Potly.Status.FILLED) {
                // claimPayout (open to anyone in v2)
                try potly.claimPayout(id) { } catch { }
            }

            _assertLockInvariant();
        }
        _assertLockInvariant();
    }

    function testFuzz_feeBpsNeverExceedsCeiling(
        uint256 target_,
        uint256 slots_,
        uint16  fee_
    ) public {
        target_ = bound(target_, MIN_CONTRIB, 5_000_000);
        slots_  = bound(slots_,  1, 5);
        fee_    = uint16(bound(uint256(fee_), 0, 100));
        if (target_ > MAX_TOTAL) target_ = MAX_TOTAL;

        Potly p = new Potly(address(usdc), treasury, fee_, MAX_TOTAL);
        address recip = makeAddr("ffRecip");
        usdc.mint(alice, target_);
        vm.prank(alice);
        usdc.approve(address(p), type(uint256).max);
        vm.prank(alice);
        uint256 id = p.createPot(recip, target_, slots_, DURATION, bytes32(0));

        // Fill with a single depositor (slots_=1 is valid now)
        vm.prank(alice);
        p.deposit(id, target_);

        uint256 feeFloor  = (target_ * fee_) / 10_000;
        uint256 tBefore   = usdc.balanceOf(treasury);
        p.claimPayout(id);

        uint256 feePaid = usdc.balanceOf(treasury) - tBefore;
        assertEq(feePaid, feeFloor, "fee not exact floor");
    }

    function testFuzz_raisedEqSumContributions(
        uint8 rawContribs
    ) public {
        uint256 n = bound(uint256(rawContribs), 1, 5);
        uint256 target_ = n * CHUNK; // each contributor puts in CHUNK
        uint256 id = _create(alice, bob, target_, n, DURATION);

        address[] memory cs = new address[](n);
        for (uint256 i; i < n; i++) {
            cs[i] = makeAddr(string(abi.encodePacked("raisedInv", i)));
            usdc.mint(cs[i], CHUNK * 2);
            vm.prank(cs[i]);
            usdc.approve(address(potly), type(uint256).max);
            vm.prank(cs[i]);
            potly.deposit(id, CHUNK);
            _assertRaisedEqSumContributions(id, cs);
            _assertLockInvariant();
        }
    }

    // ── Invariant: accepted never exceeds remaining ───────────────────────────

    function testFuzz_acceptedNeverExceedsRemaining(
        uint256 depositAmount
    ) public {
        uint256 target_ = 20_000_000; // 20 USDC
        uint256 id = _create(alice, bob, target_, 3, DURATION);
        _deposit(alice, id, 15_000_000); // remaining = 5 USDC

        depositAmount = bound(depositAmount, 1, 50_000_000);
        uint256 remaining_ = potly.remaining(id);
        uint256 bobBefore  = usdc.balanceOf(bob);

        vm.prank(bob);
        try potly.deposit(id, depositAmount) {
            uint256 pulled = bobBefore - usdc.balanceOf(bob);
            assertLe(pulled, remaining_, "accepted exceeded remaining");
            _assertLockInvariant();
        } catch {
            // AmountBelowMin or other valid revert — invariant still holds
            _assertLockInvariant();
        }
    }

    // ── Invariant: contributors <= slots <= 100 ────────────────────────────────

    function test_contributors_never_exceed_slots() public {
        uint256 id = _create(alice, bob, TARGET, 2, DURATION);
        _deposit(alice, id, CHUNK);
        _deposit(carol, id, CHUNK);
        Potly.Pot memory p = potly.getPot(id);
        assertLe(p.contributors, p.slots);
        assertLe(p.slots, uint256(100));
    }
}
