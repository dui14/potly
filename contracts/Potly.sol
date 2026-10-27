// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  Potly v2
/// @notice Flexible-contribution conditional group pot in USDC on Arc.
///         Anyone can contribute any amount toward a target; when the target
///         is fully raised the recipient can claim. Otherwise every contributor
///         can withdraw their own balance. No owner, no pause, no proxy, no upgrade.
/// @dev    If the recipient address is blocklisted by the USDC contract,
///         claimPayout will revert. This is intentional: after CLAIM_WINDOW
///         expires, contributors may withdraw via isRefundable. Choose the
///         recipient carefully; there is no post-fill recipient update.
contract Potly is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ────────────────────────────────────────────────────────────
    uint256 public constant MIN_SLOTS        = 1;
    uint256 public constant MAX_SLOTS        = 100;
    uint256 public constant MIN_CONTRIBUTION = 10_000;   // 0.01 USDC (6 dec)
    uint256 public constant MIN_DURATION     = 60;       // 60 seconds
    uint256 public constant MAX_DURATION     = 30 days;
    uint256 public constant CLAIM_WINDOW     = 7 days;

    // ── Immutables ───────────────────────────────────────────────────────────
    IERC20  public immutable usdc;
    address public immutable treasury;
    uint16  public immutable feeBps;        // max 100 (1 %)
    uint256 public immutable maxPotTotal;   // cap on pot target

    // ── Pot data ─────────────────────────────────────────────────────────────
    enum Status { OPEN, FILLED, PAID, CANCELLED }

    struct Pot {
        address creator;
        address recipient;
        uint256 target;       // total USDC to raise
        uint256 raised;       // USDC raised so far
        uint256 slots;        // maximum distinct contributors
        uint256 contributors; // current count with nonzero contribution
        uint256 deadline;     // Unix timestamp
        uint256 filledAt;     // timestamp when raised == target (0 otherwise)
        Status  status;
        bytes32 metadataHash;
    }

    uint256 public potCount;
    uint256 public totalLocked;

    mapping(uint256 => Pot)                          private _pots;
    mapping(uint256 => mapping(address => uint256))  private _contribution; // potId → wallet → amount

    // ── Events ───────────────────────────────────────────────────────────────
    event PotCreated(
        uint256 indexed potId,
        address indexed creator,
        address indexed recipient,
        uint256 target,
        uint256 slots,
        uint256 deadline,
        bytes32 metadataHash
    );
    /// @param accepted  Amount actually pulled from the depositor (≤ amount passed in)
    /// @param raised    New total raised after this deposit
    event Deposited(uint256 indexed potId, address indexed depositor, uint256 accepted, uint256 raised);
    event PotFilled(uint256 indexed potId, uint256 filledAt);
    /// @param amount  Amount returned to the withdrawer
    /// @param raised  New total raised after this withdrawal
    event Withdrawn(uint256 indexed potId, address indexed depositor, uint256 amount, uint256 raised);
    event PotCancelled(uint256 indexed potId);
    event PayoutClaimed(uint256 indexed potId, address indexed recipient, uint256 payout, uint256 fee);
    event Swept(address indexed by, uint256 amount);

    // ── Custom errors ─────────────────────────────────────────────────────────
    error ZeroAddress();
    error NoCode(address target_);
    error FeeTooHigh(uint16 bps);
    error InvalidSlots(uint256 slots);
    error InvalidDuration(uint256 duration);
    error TargetTooSmall(uint256 target_);
    error TargetExceedsMax(uint256 target_, uint256 max);
    error InvalidRecipient();
    error PotNotOpen(uint256 potId, Status status);
    error PotNotFilled(uint256 potId, Status status);
    error DeadlinePassed(uint256 potId, uint256 deadline);
    error PotFull(uint256 potId);
    error ZeroAmount();
    error AmountBelowMin(uint256 amount, uint256 min);
    error NoContribution(uint256 potId, address caller);
    error AmountExceedsContribution(uint256 amount, uint256 contribution);
    error NotRefundable(uint256 potId);
    error NotCreator(uint256 potId, address caller);
    error ClaimWindowClosed(uint256 potId);
    error NothingToSweep();

    // ── Constructor ───────────────────────────────────────────────────────────
    /// @param _usdc       Address of the USDC ERC-20 (must have code).
    /// @param _treasury   Address that receives protocol fees and swept tokens.
    ///                    MUST be a non-blocklisted address on the deployment chain
    ///                    (e.g., a plain EOA or a contract that accepts USDC transfers).
    ///                    If treasury becomes blocklisted after deployment, fee-bearing
    ///                    claimPayout calls will revert; all contributors can still
    ///                    withdraw their contributions once isRefundable returns true.
    /// @param _feeBps     Protocol fee in basis points (max 100 = 1%).
    /// @param _maxPotTotal Maximum target allowed per pot in USDC units (6 dec).
    constructor(
        address _usdc,
        address _treasury,
        uint16  _feeBps,
        uint256 _maxPotTotal
    ) {
        if (_usdc     == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_feeBps   >  100)        revert FeeTooHigh(_feeBps);

        uint256 size;
        assembly { size := extcodesize(_usdc) }
        if (size == 0) revert NoCode(_usdc);

        usdc        = IERC20(_usdc);
        treasury    = _treasury;
        feeBps      = _feeBps;
        maxPotTotal = _maxPotTotal;
    }

    // ── Core functions ────────────────────────────────────────────────────────

    /// @notice Create a new flexible group pot.
    function createPot(
        address recipient,
        uint256 target,
        uint256 slots,
        uint256 durationSeconds,
        bytes32 metadataHash
    ) external nonReentrant returns (uint256 potId) {
        if (recipient == address(0) || recipient == address(this))
            revert InvalidRecipient();
        if (slots < MIN_SLOTS || slots > MAX_SLOTS)
            revert InvalidSlots(slots);
        if (durationSeconds < MIN_DURATION || durationSeconds > MAX_DURATION)
            revert InvalidDuration(durationSeconds);
        if (target < MIN_CONTRIBUTION)
            revert TargetTooSmall(target);
        if (target > maxPotTotal)
            revert TargetExceedsMax(target, maxPotTotal);

        potId = potCount++;
        uint256 dl = block.timestamp + durationSeconds;
        _pots[potId] = Pot({
            creator:      msg.sender,
            recipient:    recipient,
            target:       target,
            raised:       0,
            slots:        slots,
            contributors: 0,
            deadline:     dl,
            filledAt:     0,
            status:       Status.OPEN,
            metadataHash: metadataHash
        });

        emit PotCreated(potId, msg.sender, recipient, target, slots, dl, metadataHash);
    }

    /// @notice Contribute `amount` USDC toward pot `potId`.
    ///         The contract accepts at most (target - raised); any excess is
    ///         never pulled from the caller.
    function deposit(uint256 potId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        Pot storage pot = _pots[potId];

        if (pot.status != Status.OPEN)
            revert PotNotOpen(potId, pot.status);
        if (block.timestamp >= pot.deadline)
            revert DeadlinePassed(potId, pot.deadline);

        uint256 rem = pot.target - pot.raised;
        if (rem == 0) revert PotFull(potId);

        // New contributors need a free slot
        bool isNew = _contribution[potId][msg.sender] == 0;
        if (isNew && pot.contributors >= pot.slots) revert PotFull(potId);

        // Cap accepted to remaining
        uint256 accepted = amount > rem ? rem : amount;

        // Enforce MIN_CONTRIBUTION unless this accepted amount exactly clears the remainder
        if (accepted < MIN_CONTRIBUTION && accepted != rem)
            revert AmountBelowMin(accepted, MIN_CONTRIBUTION);

        // ── Effects (before interaction) ──────────────────────────────────────
        _contribution[potId][msg.sender] += accepted;
        pot.raised       += accepted;
        totalLocked      += accepted;
        if (isNew) pot.contributors++;

        bool filled = pot.raised == pot.target;
        if (filled) {
            pot.status   = Status.FILLED;
            pot.filledAt = block.timestamp;
            emit PotFilled(potId, block.timestamp);
        }

        emit Deposited(potId, msg.sender, accepted, pot.raised);

        // ── Interaction ───────────────────────────────────────────────────────
        usdc.safeTransferFrom(msg.sender, address(this), accepted);
    }

    /// @notice Withdraw `amount` from the caller's own contribution.
    ///         Allowed when isRefundable; never after PAID.
    function withdraw(uint256 potId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        Pot storage pot = _pots[potId];
        uint256 contrib = _contribution[potId][msg.sender];

        if (contrib == 0)         revert NoContribution(potId, msg.sender);
        if (amount > contrib)     revert AmountExceedsContribution(amount, contrib);
        if (!isRefundable(potId)) revert NotRefundable(potId);

        // ── Effects ───────────────────────────────────────────────────────────
        _contribution[potId][msg.sender] = contrib - amount;
        pot.raised  -= amount;
        totalLocked -= amount;
        if (_contribution[potId][msg.sender] == 0) pot.contributors--;

        emit Withdrawn(potId, msg.sender, amount, pot.raised);

        // ── Interaction ───────────────────────────────────────────────────────
        usdc.safeTransfer(msg.sender, amount);
    }

    /// @notice Creator cancels an OPEN pot; contributors may then withdraw.
    function cancel(uint256 potId) external nonReentrant {
        Pot storage pot = _pots[potId];
        if (pot.creator != msg.sender)      revert NotCreator(potId, msg.sender);
        if (pot.status  != Status.OPEN)     revert PotNotOpen(potId, pot.status);

        pot.status = Status.CANCELLED;
        emit PotCancelled(potId);
    }

    /// @notice Anyone may trigger payout once the pot is FILLED and within
    ///         the claim window. Funds always go to the pot's recipient.
    function claimPayout(uint256 potId) external nonReentrant {
        Pot storage pot = _pots[potId];

        if (pot.status != Status.FILLED)
            revert PotNotFilled(potId, pot.status);
        if (block.timestamp > pot.filledAt + CLAIM_WINDOW)
            revert ClaimWindowClosed(potId);

        uint256 total  = pot.target;
        uint256 fee    = (total * feeBps) / 10_000;
        uint256 payout = total - fee;

        // ── Effects ───────────────────────────────────────────────────────────
        pot.status   = Status.PAID;
        totalLocked -= total;

        emit PayoutClaimed(potId, pot.recipient, payout, fee);

        // ── Interactions ──────────────────────────────────────────────────────
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        usdc.safeTransfer(pot.recipient, payout);
    }

    /// @notice Sweep any USDC balance above totalLocked to the treasury.
    function sweepUnaccounted() external nonReentrant {
        uint256 bal   = usdc.balanceOf(address(this));
        uint256 extra = bal > totalLocked ? bal - totalLocked : 0;
        if (extra == 0) revert NothingToSweep();
        emit Swept(msg.sender, extra);
        usdc.safeTransfer(treasury, extra);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getPot(uint256 potId) external view returns (Pot memory) {
        return _pots[potId];
    }

    /// @notice USDC contributed by `who` to pot `potId`.
    function contributionOf(uint256 potId, address who) external view returns (uint256) {
        return _contribution[potId][who];
    }

    /// @notice How much USDC still needs to be raised for pot `potId`.
    function remaining(uint256 potId) external view returns (uint256) {
        Pot storage pot = _pots[potId];
        return pot.target > pot.raised ? pot.target - pot.raised : 0;
    }

    /// @notice Unix timestamp at which the claim window closes.
    ///         Returns filledAt + CLAIM_WINDOW for FILLED and PAID pots; 0 otherwise.
    function claimDeadline(uint256 potId) external view returns (uint256) {
        Pot storage pot = _pots[potId];
        if (pot.status == Status.FILLED || pot.status == Status.PAID) {
            return pot.filledAt + CLAIM_WINDOW;
        }
        return 0;
    }

    /// @notice True when a contributor may call withdraw on this pot.
    ///         True if status != PAID and (OPEN, CANCELLED, or FILLED after claim window).
    function isRefundable(uint256 potId) public view returns (bool) {
        Pot storage pot = _pots[potId];
        if (pot.status == Status.PAID)      return false;
        if (pot.status == Status.OPEN)      return true;
        if (pot.status == Status.CANCELLED) return true;
        // FILLED: refundable only after claim window expires
        return block.timestamp > pot.filledAt + CLAIM_WINDOW;
    }
}
