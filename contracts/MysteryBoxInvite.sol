// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, eaddress, ebool, euint32, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @notice Confidential ERC-7984 pull and payout. The caller must already be an operator for pulls.
interface IInviteToken {
    function confidentialTransferFrom(address from, address to, euint64 amount) external returns (euint64 transferred);

    function confidentialTransfer(address to, euint64 amount) external returns (euint64 transferred);
}

interface IClearStakeToken {
    function balanceOf(address owner) external view returns (uint256);
}

/// @title Mystery Box Invite
/// @notice Two players join a link that stays open for 48 hours, each plays three shell hands for free,
///         then pays $1 to commit the score. The higher encrypted score wins $2. Scores are not publicly decryptable.
/// @dev `block.timestamp` is only the invite window. The ball and the score come from `FHE.randEuint32`.
contract MysteryBoxInvite is ZamaEthereumConfig {
    uint256 public constant STAKE = 1_000_000;
    uint256 public constant PRIZE = 2_000_000;
    uint256 public constant OPEN_WINDOW = 48 hours;
    uint8 public constant HANDS_PER_PLAYER = 3;
    uint32 public constant ROLL_MODULUS = 1024;
    uint32 public constant COMMON_BELOW = 614;
    uint32 public constant RARE_BELOW = 870;
    uint32 public constant EPIC_BELOW = 993;

    enum Phase {
        Empty,
        Open,
        Sealed,
        Refunded,
        Settling
    }

    struct Invite {
        address host;
        uint64 deadline;
        Phase phase;
        uint8 paymentKind;
        uint256 pot;
        address winner;
        bool claimed;
        eaddress encryptedWinner;
    }

    struct Payment {
        uint64 funded;
        uint64 due;
        euint64 pending;
    }

    mapping(uint256 => Payment[2]) private _payments;
    mapping(uint256 => ebool) private _voidDraw;
    bool private _transferring;
    error TransferInProgress();
    error InvalidPayment();
    event SettlementComplete(uint256 indexed inviteId, address winner);

    modifier locked() {
        if (_transferring) revert TransferInProgress();
        _transferring = true;
        _;
        _transferring = false;
    }

    address public immutable cUsdt;
    address public immutable underlyingToken;
    /// @dev Local tests pass true so they can check the comparison. Sepolia deploys pass false.
    bool public immutable scoreDebug;
    uint256 public inviteCount;

    mapping(uint256 inviteId => Invite) private _invites;
    mapping(uint256 inviteId => address[2]) private _players;
    mapping(uint256 inviteId => euint32) private _score0;
    mapping(uint256 inviteId => euint32) private _score1;
    mapping(uint256 inviteId => euint32) private _ball0;
    mapping(uint256 inviteId => euint32) private _ball1;
    mapping(uint256 inviteId => uint8) private _hands0;
    mapping(uint256 inviteId => uint8) private _hands1;
    mapping(uint256 inviteId => bool) private _committed0;
    mapping(uint256 inviteId => bool) private _committed1;

    event InviteCreated(uint256 indexed inviteId, address indexed host, uint64 deadline);
    event PlayerJoined(uint256 indexed inviteId, address indexed player);
    event PlayerPlayed(uint256 indexed inviteId, address indexed player, uint8 cup);
    event PlayerCommitted(uint256 indexed inviteId, address indexed player);
    event InviteSealed(uint256 indexed inviteId, bytes32 winnerHandle);
    event PrizeClaimed(uint256 indexed inviteId, address indexed winner, uint256 prize);

    error ZeroToken();
    error BadPhase();
    error AlreadyJoined();
    error InviteFull();
    error InviteExpired();
    error InviteStillOpen();
    error PaymentKindMismatch();
    error FallbackPaymentFailed();
    error BadCup();
    error AlreadyPlayed();
    error NotSeated();
    error NeedThreeHands();
    error AlreadyCommitted();

    constructor(address cUsdt_, address underlyingToken_, bool scoreDebug_) {
        if (cUsdt_.code.length == 0 || underlyingToken_.code.length == 0) revert ZeroToken();
        cUsdt = cUsdt_;
        underlyingToken = underlyingToken_;
        scoreDebug = scoreDebug_;
    }

    function getInvite(
        uint256 inviteId
    )
        external
        view
        returns (
            address host,
            uint64 deadline,
            Phase phase,
            uint8 paymentKind,
            uint256 pot,
            address winner,
            bool claimed,
            bytes32 winnerHandle
        )
    {
        Invite memory invite = _invites[inviteId];
        return (
            invite.host,
            invite.deadline,
            invite.phase,
            invite.paymentKind,
            invite.pot,
            invite.winner,
            invite.claimed,
            eaddress.unwrap(invite.encryptedWinner)
        );
    }

    function getSeats(uint256 inviteId) external view returns (address player0, address player1) {
        return (_players[inviteId][0], _players[inviteId][1]);
    }

    function getHands(uint256 inviteId) external view returns (uint8 hostHands, uint8 guestHands) {
        return (_hands0[inviteId], _hands1[inviteId]);
    }

    function getCommitted(uint256 inviteId) external view returns (bool hostCommitted, bool guestCommitted) {
        return (_committed0[inviteId], _committed1[inviteId]);
    }

    /// @notice Score handle. Players cannot decrypt it unless the contract was deployed with score debug.
    function getScoreHandle(uint256 inviteId, uint8 slot) external view returns (euint32) {
        return slot == 0 ? _score0[inviteId] : _score1[inviteId];
    }

    /// @notice Ball index 0–2, or 3 for a void draw. Only the player who played that seat can decrypt it.
    function getBallHandle(uint256 inviteId, uint8 slot) external view returns (euint32) {
        return slot == 0 ? _ball0[inviteId] : _ball1[inviteId];
    }

    /// @notice Opening the table is free. The $1 stake is paid later, when the score is committed.
    function createInvite() external returns (uint256 inviteId) {
        inviteId = _open(msg.sender);
    }

    /// @notice Taking the open seat is free. The $1 stake is paid when the score is committed.
    function joinInvite(uint256 inviteId) external {
        Invite storage invite = _invites[inviteId];
        if (invite.phase != Phase.Open) revert BadPhase();
        if (block.timestamp > invite.deadline) revert InviteExpired();
        if (_players[inviteId][0] == msg.sender || _players[inviteId][1] == msg.sender) revert AlreadyJoined();
        if (_players[inviteId][1] != address(0)) revert InviteFull();
        _players[inviteId][1] = msg.sender;
        emit PlayerJoined(inviteId, msg.sender);
    }

    /// @notice Play one of three shell hands for free. The score accumulates on ciphertext.
    function play(uint256 inviteId, uint8 cup) external {
        if (cup > 2) revert BadCup();
        Invite storage invite = _invites[inviteId];
        if (invite.phase != Phase.Open) revert BadPhase();
        if (block.timestamp > invite.deadline) revert InviteExpired();
        uint8 slot = _seatOf(inviteId, msg.sender);
        uint8 hands = slot == 0 ? _hands0[inviteId] : _hands1[inviteId];
        if (hands >= HANDS_PER_PLAYER) revert AlreadyPlayed();
        if (slot == 0) _hands0[inviteId] = hands + 1;
        else _hands1[inviteId] = hands + 1;
        _hideScore(inviteId, slot, cup, msg.sender);
        emit PlayerPlayed(inviteId, msg.sender, cup);
    }

    function getPayment(
        uint256 id,
        uint8 slot
    ) external view returns (uint64 funded, uint64 due, bytes32 pendingHandle) {
        Payment storage payment = _payments[id][slot];
        return (payment.funded, payment.due, euint64.unwrap(payment.pending));
    }

    function commit(uint256 id) external locked {
        (uint8 slot, uint64 amount) = _prepareStake(id, 1);
        _recordTransfer(
            id,
            slot,
            IInviteToken(cUsdt).confidentialTransferFrom(msg.sender, address(this), _tokenAmount(amount))
        );
    }

    function commitFallback(uint256 id) external locked {
        (uint8 slot, uint64 amount) = _prepareStake(id, 2);
        _moveClear(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amount),
            address(this),
            amount
        );
        _creditStake(id, slot, amount);
    }

    function confirmTransfer(uint256 id, uint8 slot, bytes calldata cleartexts, bytes calldata proof) external locked {
        Invite storage invite = _invites[id];
        Payment storage payment = _payments[id][slot];
        if (!FHE.isInitialized(payment.pending)) revert InvalidPayment();
        _verify(euint64.unwrap(payment.pending), cleartexts, proof);
        uint64 amount = abi.decode(cleartexts, (uint64));
        payment.pending = euint64.wrap(bytes32(0));
        if (invite.phase == Phase.Open) {
            if (amount > STAKE - payment.funded) revert InvalidPayment();
            _creditStake(id, slot, amount);
        } else {
            _creditPayout(id, slot, amount);
        }
    }

    function refundExpired(uint256 id) external locked {
        Invite storage invite = _invites[id];
        if (invite.phase != Phase.Open) revert BadPhase();
        if (block.timestamp <= invite.deadline) revert InviteStillOpen();
        Payment[2] storage payments = _payments[id];
        if (FHE.isInitialized(payments[0].pending) || FHE.isInitialized(payments[1].pending)) revert InvalidPayment();
        invite.phase = Phase.Refunded;
        payments[0].due = payments[0].funded;
        payments[1].due = payments[1].funded;
        _finish(id);
    }

    function claim(uint256 id, bytes calldata cleartexts, bytes calldata proof) external locked {
        Invite storage invite = _invites[id];
        if (invite.phase != Phase.Sealed) revert BadPhase();
        _verify(eaddress.unwrap(invite.encryptedWinner), cleartexts, proof);
        address result = abi.decode(cleartexts, (address));
        bool voided = result == address(1);
        invite.phase = voided ? Phase.Refunded : Phase.Settling;
        invite.winner = voided ? address(0) : result;
        if (result == address(0) || voided) {
            _payments[id][0].due = uint64(STAKE);
            _payments[id][1].due = uint64(STAKE);
        } else {
            _payments[id][_seatOf(id, result)].due = uint64(PRIZE);
        }
    }

    function paySeat(uint256 id, uint8 slot) external locked {
        Invite storage invite = _invites[id];
        if (invite.phase != Phase.Settling && invite.phase != Phase.Refunded) revert BadPhase();
        Payment storage payment = _payments[id][slot];
        if (payment.due == 0 || FHE.isInitialized(payment.pending)) revert InvalidPayment();
        address player = _players[id][slot];
        if (invite.paymentKind == 2) {
            _moveClear(abi.encodeWithSignature("transfer(address,uint256)", player, payment.due), player, payment.due);
            _creditPayout(id, slot, payment.due);
        } else {
            _recordTransfer(id, slot, IInviteToken(cUsdt).confidentialTransfer(player, _tokenAmount(payment.due)));
        }
    }

    function _verify(bytes32 handle, bytes calldata cleartexts, bytes calldata proof) private {
        if (handle == bytes32(0)) revert InvalidPayment();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = handle;
        FHE.checkSignatures(handles, cleartexts, proof);
    }

    function _open(address host) internal returns (uint256 inviteId) {
        inviteId = ++inviteCount;
        Invite storage invite = _invites[inviteId];
        invite.host = host;
        invite.deadline = uint64(block.timestamp + OPEN_WINDOW);
        invite.phase = Phase.Open;
        _players[inviteId][0] = host;
        emit InviteCreated(inviteId, host, invite.deadline);
        emit PlayerJoined(inviteId, host);
    }

    function _prepareStake(uint256 id, uint8 kind) private returns (uint8 slot, uint64 amount) {
        Invite storage invite = _invites[id];
        if (invite.phase != Phase.Open) revert BadPhase();
        if (block.timestamp > invite.deadline) revert InviteExpired();
        slot = _seatOf(id, msg.sender);
        if ((slot == 0 ? _hands0[id] : _hands1[id]) != HANDS_PER_PLAYER) revert NeedThreeHands();
        Payment storage payment = _payments[id][slot];
        if (payment.funded == STAKE) revert AlreadyCommitted();
        if (FHE.isInitialized(payment.pending)) revert InvalidPayment();
        if (invite.paymentKind == 0) invite.paymentKind = kind;
        else if (invite.paymentKind != kind) revert PaymentKindMismatch();
        return (slot, uint64(STAKE) - payment.funded);
    }

    function _creditStake(uint256 id, uint8 slot, uint64 amount) private {
        Invite storage invite = _invites[id];
        Payment[2] storage payments = _payments[id];
        payments[slot].funded += amount;
        invite.pot += amount;
        if (payments[slot].funded == STAKE) {
            if (slot == 0) _committed0[id] = true;
            else _committed1[id] = true;
            emit PlayerCommitted(id, _players[id][slot]);
        }
        if (_committed0[id] && _committed1[id]) _seal(id);
        else if (
            invite.pot == 0 && !FHE.isInitialized(payments[0].pending) && !FHE.isInitialized(payments[1].pending)
        ) {
            invite.paymentKind = 0;
        }
    }

    function _seatOf(uint256 inviteId, address player) internal view returns (uint8) {
        if (_players[inviteId][0] == player) return 0;
        if (_players[inviteId][1] == player) return 1;
        revert NotSeated();
    }

    /// @notice A hit scores the hidden power. A miss scores 0. Hands accumulate on the seat's score.
    function _hideScore(uint256 inviteId, uint8 slot, uint8 cup, address player) internal {
        euint32 roll = FHE.randEuint32(ROLL_MODULUS);
        euint32 power = FHE.asEuint32(150);
        power = FHE.select(FHE.lt(roll, EPIC_BELOW), FHE.asEuint32(70), power);
        power = FHE.select(FHE.lt(roll, RARE_BELOW), FHE.asEuint32(30), power);
        power = FHE.select(FHE.lt(roll, COMMON_BELOW), FHE.asEuint32(10), power);

        // Excluding the largest uint32 leaves three equally sized residue classes.
        euint32 draw = _drawShell();
        ebool voidDraw = FHE.eq(draw, type(uint32).max);
        _voidDraw[inviteId] = FHE.allowThis(FHE.or(_voidDraw[inviteId], voidDraw));
        euint32 ball = FHE.select(voidDraw, FHE.asEuint32(3), FHE.rem(draw, 3));
        ebool hit = FHE.eq(ball, FHE.asEuint32(cup));
        euint32 handScore = FHE.select(hit, power, FHE.asEuint32(0));

        if (slot == 0) {
            _score0[inviteId] = FHE.add(_score0[inviteId], handScore);
            _ball0[inviteId] = ball;
            FHE.allowThis(_score0[inviteId]);
        } else {
            _score1[inviteId] = FHE.add(_score1[inviteId], handScore);
            _ball1[inviteId] = ball;
            FHE.allowThis(_score1[inviteId]);
        }
        FHE.allowThis(ball);
        FHE.allow(ball, player);
        if (scoreDebug) FHE.allow(slot == 0 ? _score0[inviteId] : _score1[inviteId], player);
    }

    function _drawShell() internal virtual returns (euint32) {
        return FHE.randEuint32();
    }

    /// @notice Reveal the winner, a tie, or a void draw. Scores stay encrypted.
    function _seal(uint256 inviteId) internal {
        Invite storage invite = _invites[inviteId];
        euint32 hostScore = _score0[inviteId];
        euint32 guestScore = _score1[inviteId];
        ebool guestHigher = FHE.gt(guestScore, hostScore);
        eaddress leader = FHE.select(
            guestHigher,
            FHE.asEaddress(_players[inviteId][1]),
            FHE.asEaddress(_players[inviteId][0])
        );
        leader = FHE.select(FHE.eq(hostScore, guestScore), FHE.asEaddress(address(0)), leader);
        leader = FHE.select(_voidDraw[inviteId], FHE.asEaddress(address(1)), leader);
        FHE.allowThis(leader);
        FHE.makePubliclyDecryptable(leader);
        invite.encryptedWinner = leader;
        invite.phase = Phase.Sealed;
        emit InviteSealed(inviteId, eaddress.unwrap(leader));
    }

    function _tokenAmount(uint64 amount) private returns (euint64 encrypted) {
        encrypted = FHE.asEuint64(amount);
        FHE.allowTransient(encrypted, cUsdt);
    }

    function _recordTransfer(uint256 id, uint8 slot, euint64 transferred) private {
        _payments[id][slot].pending = FHE.makePubliclyDecryptable(transferred);
    }

    function _moveClear(bytes memory callData, address recipient, uint256 amount) private {
        uint256 before = IClearStakeToken(underlyingToken).balanceOf(recipient);
        (bool ok, bytes memory data) = underlyingToken.call(callData);
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert FallbackPaymentFailed();
        if (IClearStakeToken(underlyingToken).balanceOf(recipient) != before + amount) revert InvalidPayment();
    }

    function _creditPayout(uint256 id, uint8 slot, uint64 amount) private {
        Payment storage payment = _payments[id][slot];
        if (amount > payment.due) revert InvalidPayment();
        payment.due -= amount;
        _invites[id].pot -= amount;
        _finish(id);
    }

    function _finish(uint256 id) private {
        Invite storage invite = _invites[id];
        if (invite.pot != 0) return;
        invite.claimed = true;
        if (invite.winner != address(0)) emit PrizeClaimed(id, invite.winner, PRIZE);
        emit SettlementComplete(id, invite.winner);
    }
}
