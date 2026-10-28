// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import "../Potly.sol";

/**
 * @title PotlyRedeposit
 * @notice Tests deposit → full withdraw → re-deposit by the same wallet
 *         in the same open pot, covering both solo and multi-contributor scenarios.
 *
 * Root-cause investigation
 * ────────────────────────
 * After a full withdrawal _contribution[potId][msg.sender] becomes 0.
 * On the next deposit `isNew = (_contribution[potId][msg.sender] == 0)` → true.
 * Two possible outcomes:
 *   (a) pot.contributors < pot.slots  → free slot available → deposit accepted ✓
 *   (b) pot.contributors >= pot.slots → no free slot → PotFull(potId) ✗
 *
 * Case (a) is correct: a wallet that withdrew fully freed its own slot, so
 * contributors decremented by 1; re-depositing re-uses that same slot.
 * Case (b) is a contract constraint, not a bug: there is no free slot.
 *
 * The UI bug is separate: stale allowance / stale "approved" state in the
 * browser after a deposit consumes the exact-amount approval, causing the
 * next deposit attempt to skip the Approve step and revert on-chain.
 * Fix: refetch allowance and reset the step machine after every confirmed tx.
 */
contract PotlyRedepositTest is Test {
    Potly    public potly;
    MockUSDC public usdc;

    address constant TREASURY  = address(0xdead);
    address constant CREATOR   = address(0x1);
    address constant ALICE     = address(0x2);   // solo re-depositor
    address constant BOB       = address(0x3);   // other contributor
    address constant RECIPIENT = address(0x4);

    uint256 constant TARGET     = 10_000_000;   // 10 USDC (6 dec)
    uint256 constant SLOT2      = 2;
    uint256 constant SLOT3      = 3;
    uint256 constant DURATION   = 7 days;

    function setUp() public {
        usdc  = new MockUSDC();
        potly = new Potly(address(usdc), TREASURY, 5, 500_000_000);

        // Fund participants
        usdc.mint(ALICE, 50_000_000);
        usdc.mint(BOB,   50_000_000);
        usdc.mint(CREATOR, 1_000_000);

        // Approvals
        vm.prank(ALICE);   usdc.approve(address(potly), type(uint256).max);
        vm.prank(BOB);     usdc.approve(address(potly), type(uint256).max);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _createPot(uint256 slots) internal returns (uint256 potId) {
        vm.prank(CREATOR);
        potId = potly.createPot(RECIPIENT, TARGET, slots, DURATION, bytes32(0));
    }

    // ── Test A: solo re-deposit (slots=2; Alice is the only contributor) ─────

    /// Alice deposits half, withdraws fully, then deposits again.
    /// Expect: second deposit succeeds (Alice freed her own slot by withdrawing).
    function test_redeposit_soloAfterFullWithdraw() public {
        uint256 potId = _createPot(SLOT2);
        uint256 half  = TARGET / 2;

        // 1. First deposit
        vm.prank(ALICE);
        potly.deposit(potId, half);
        assertEq(potly.contributionOf(potId, ALICE), half, "initial deposit wrong");
        assertEq(potly.getPot(potId).contributors, 1);

        // 2. Full withdrawal
        vm.prank(ALICE);
        potly.withdraw(potId, half);
        assertEq(potly.contributionOf(potId, ALICE), 0, "contribution should be 0");
        assertEq(potly.getPot(potId).contributors, 0, "contributors should be 0 after full withdraw");

        // 3. Re-deposit — must succeed
        vm.prank(ALICE);
        potly.deposit(potId, half);
        assertEq(potly.contributionOf(potId, ALICE), half, "re-deposit: contribution wrong");
        assertEq(potly.getPot(potId).contributors, 1, "re-deposit: contributor count wrong");
    }

    /// Alice deposits twice (partial then more), withdraws fully, then re-deposits.
    function test_redeposit_afterTwoDeposits() public {
        uint256 potId  = _createPot(SLOT2);
        uint256 third  = TARGET / 3;

        vm.prank(ALICE);
        potly.deposit(potId, third);
        vm.prank(ALICE);
        potly.deposit(potId, third);

        uint256 contrib = potly.contributionOf(potId, ALICE);

        vm.prank(ALICE);
        potly.withdraw(potId, contrib);

        // Re-deposit
        vm.prank(ALICE);
        potly.deposit(potId, third);
        assertEq(potly.contributionOf(potId, ALICE), third);
    }

    // ── Test B: re-deposit with another contributor already in the pot ───────

    /// Bob holds 1 slot; Alice deposits, withdraws, re-deposits; slots=2 so free.
    function test_redeposit_withOtherContributor_freeSlotsAvailable() public {
        uint256 potId = _createPot(SLOT2);
        uint256 half  = TARGET / 2;

        // Bob occupies one slot
        vm.prank(BOB);
        potly.deposit(potId, half);
        assertEq(potly.getPot(potId).contributors, 1);

        // Alice takes the second slot
        vm.prank(ALICE);
        potly.deposit(potId, half / 2);
        assertEq(potly.getPot(potId).contributors, 2);

        // Alice withdraws fully — frees her slot
        vm.prank(ALICE);
        potly.withdraw(potId, half / 2);
        assertEq(potly.getPot(potId).contributors, 1, "Alice slot not freed");

        // Alice re-deposits — slot is now free again
        vm.prank(ALICE);
        potly.deposit(potId, half / 2);
        assertEq(potly.getPot(potId).contributors, 2, "re-deposit contributor count wrong");
    }

    /// All slots taken (slots=2, Alice + Bob). Alice withdraws fully (freeing slot).
    /// Pot now has 1 contributor / 2 slots, so Alice can re-deposit.
    function test_redeposit_slotFreedByWithdraw_slots2() public {
        uint256 potId = _createPot(SLOT2);
        uint256 half  = TARGET / 2;

        vm.prank(ALICE); potly.deposit(potId, half / 2);
        vm.prank(BOB);   potly.deposit(potId, half / 2);
        assertEq(potly.getPot(potId).contributors, 2, "both in pot");

        vm.prank(ALICE);
        potly.withdraw(potId, half / 2);
        assertEq(potly.getPot(potId).contributors, 1, "Alice slot freed");

        // Alice can re-deposit since contributors(1) < slots(2)
        vm.prank(ALICE);
        potly.deposit(potId, half / 2);
        assertEq(potly.getPot(potId).contributors, 2);
    }

    // ── Test C: re-deposit blocked when no slots are free ───────────────────

    /// slots=1, Alice is the sole contributor. After Alice withdraws fully,
    /// contributors=0 and slots=1; re-deposit IS possible (slot freed).
    function test_redeposit_singleSlot_succeeds() public {
        uint256 potId  = _createPot(1);
        uint256 half   = TARGET / 2;

        vm.prank(ALICE); potly.deposit(potId, half);
        vm.prank(ALICE); potly.withdraw(potId, half);
        assertEq(potly.getPot(potId).contributors, 0);

        // Only 1 slot, Alice freed it — should work
        vm.prank(ALICE);
        potly.deposit(potId, half);
        assertEq(potly.contributionOf(potId, ALICE), half);
    }

    /// slots=1, Bob holds the slot. Alice has NEVER contributed.
    /// Alice's deposit must revert with PotFull because contributors(1) >= slots(1).
    function test_redeposit_newWallet_potFull_reverts() public {
        uint256 potId  = _createPot(1);
        uint256 half   = TARGET / 2;

        vm.prank(BOB); potly.deposit(potId, half);
        assertEq(potly.getPot(potId).contributors, 1);

        // Alice never deposited; she is "new" and there is no free slot
        vm.expectRevert(abi.encodeWithSelector(Potly.PotFull.selector, potId));
        vm.prank(ALICE);
        potly.deposit(potId, half / 4);
    }

    /// slots=2, Alice + Bob hold both slots. Alice partially withdraws (not fully).
    /// _contribution > 0 → Alice is still "old", so re-adding more should succeed.
    function test_partialWithdraw_then_deposit_sameSlot() public {
        uint256 potId = _createPot(SLOT2);
        uint256 half  = TARGET / 2;
        uint256 quart = half / 2;

        vm.prank(ALICE); potly.deposit(potId, half);
        vm.prank(BOB);   potly.deposit(potId, quart);

        // Alice partial withdraw
        vm.prank(ALICE);
        potly.withdraw(potId, quart);
        assertEq(potly.contributionOf(potId, ALICE), half - quart);
        // Alice is still an existing contributor (contribution > 0)
        assertEq(potly.getPot(potId).contributors, 2);

        // Alice adds more — she is "old" (isNew=false), no slot check needed
        vm.prank(ALICE);
        potly.deposit(potId, quart);
        assertEq(potly.contributionOf(potId, ALICE), half);
    }
}

// ── Minimal ERC-20 mock ───────────────────────────────────────────────────────

contract MockUSDC {
    string  public name     = "USD Coin";
    string  public symbol   = "USDC";
    uint8   public decimals = 6;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply    += amount;
        balanceOf[to]  += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: insufficient");
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ERC20: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}
