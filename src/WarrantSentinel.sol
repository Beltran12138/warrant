// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";

/// @title WarrantSentinel
/// @notice Reactive contract (Reactive Network) that holds an AI agent to its own disclosures.
///         Rule: every time the agent moves the watched asset out of its wallet (a trade), there must
///         be an unused PASS or WARN preflight disclosure from that agent, under this guardian, in front
///         of it. One disclosure covers one outflow. If there is none, the sentinel asks the guardian on
///         the origin chain to freeze the agent: budget to zero, Warrant revoked.
/// @dev    Subscriptions (all on the one origin chain):
///           - WarrantRegistry.WarrantSet(principal = guardian)  -> start watching that agent's outflows
///           - WarrantRegistry.PreflightAttested(principal = guardian)       -> a disclosure the agent sent
///           - WarrantAttestor.SignedPreflightAttested(principal = guardian)  -> a disclosure it signed
///           - asset.Transfer(from = agent), added per agent at runtime     -> a trade
///           - WarrantGuardian.Unfrozen                                      -> reset after the owner lifts it
///         Outflows back to the guardian are refunds, not trades. Amounts are not matched against the
///         disclosed quote (the quote is only a hash on chain): one disclosure covers one outflow of any
///         size, and the guardian's budget is what caps size. Disclosures must reach the chain before the
///         trade they cover; the sentinel treats events in the order Reactive Network delivers them.
contract WarrantSentinel is AbstractReactive {
    // keccak256 of the event signatures
    uint256 internal constant WARRANT_SET_TOPIC = uint256(
        keccak256(
            "WarrantSet(address,address,uint32,(uint64,uint16,uint16,uint16,bool,bool,bool,uint64))"
        )
    );
    uint256 internal constant PREFLIGHT_ATTESTED_TOPIC =
        uint256(keccak256("PreflightAttested(address,address,bytes32,uint32,uint8,bytes32)"));
    uint256 internal constant SIGNED_PREFLIGHT_TOPIC =
        uint256(keccak256("SignedPreflightAttested(address,address,bytes32,uint32,uint8,bytes32,address)"));
    uint256 internal constant TRANSFER_TOPIC = uint256(keccak256("Transfer(address,address,uint256)"));
    uint256 internal constant UNFROZEN_TOPIC = uint256(keccak256("Unfrozen(address)"));

    uint8 internal constant VERDICT_FAIL = 2;
    uint8 internal constant REASON_UNDISCLOSED = 0;
    uint8 internal constant REASON_TRADED_AFTER_FAIL = 1;
    uint64 internal constant CALLBACK_GAS_LIMIT = 300_000;

    address public immutable owner;
    uint256 public immutable originChainId;
    address public immutable registry;
    address public immutable attestor;
    address public immutable asset;
    address public guardian;

    /// agent => outflows of `asset` already being watched
    mapping(address => bool) public watched;
    /// agent => PASS/WARN disclosures not yet used by a trade
    mapping(address => uint256) public unusedDisclosures;
    /// agent => its latest disclosure was FAIL (cleared by a later PASS/WARN or by a reset)
    mapping(address => bool) public lastWasFail;
    /// agent => freeze requested and not yet lifted by the guardian owner
    mapping(address => bool) public freezeRequested;

    event GuardianSet(address guardian);
    event Watching(address indexed agent);
    event Disclosure(address indexed agent, bytes32 indexed quoteHash, uint8 verdict, uint256 unused);
    event TradeCovered(address indexed agent, uint256 amount, uint256 unusedLeft, uint256 txHash);
    event Violation(address indexed agent, uint8 reason, uint256 amount, uint256 txHash);
    event Reset(address indexed agent);

    error NotOwner();
    error GuardianAlreadySet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 originChainId_, address registry_, address attestor_, address asset_) payable {
        owner = msg.sender;
        originChainId = originChainId_;
        registry = registry_;
        attestor = attestor_;
        asset = asset_;
    }

    /// @notice Point the sentinel at its guardian (deployed after the sentinel, which it must name as
    ///         its only callback sender) and subscribe to everything keyed on it. Once only.
    function setGuardian(address guardian_) external onlyOwner {
        if (guardian != address(0)) revert GuardianAlreadySet();
        guardian = guardian_;
        uint256 g = uint256(uint160(guardian_));
        SYSTEM.subscribe(originChainId, registry, WARRANT_SET_TOPIC, g, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId, registry, PREFLIGHT_ATTESTED_TOPIC, g, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId, attestor, SIGNED_PREFLIGHT_TOPIC, g, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(originChainId, guardian_, UNFROZEN_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit GuardianSet(guardian_);
    }

    /// @notice Watch an agent whose Warrant was set before the sentinel was pointed at the guardian.
    function watch(address agent) external onlyOwner {
        _watch(agent);
    }

    /// @notice Settle any reactive-transaction debt from this contract's balance (anyone may top up).
    function coverDebt() external {
        _coverDebt();
    }

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        if (log_.chainId != originChainId) return;

        if (log_.topic0 == TRANSFER_TOPIC && log_.contractAddress == asset && log_.opCode == 3) {
            _onOutflow(log_);
        } else if (log_.topic0 == SIGNED_PREFLIGHT_TOPIC && log_.contractAddress == attestor && log_.opCode == 4) {
            (, uint8 verdict,,) = abi.decode(log_.data, (uint32, uint8, bytes32, address));
            _onDisclosure(address(uint160(log_.topic2)), bytes32(log_.topic3), verdict);
        } else if (log_.topic0 == PREFLIGHT_ATTESTED_TOPIC && log_.contractAddress == registry && log_.opCode == 4) {
            (, uint8 verdict,) = abi.decode(log_.data, (uint32, uint8, bytes32));
            _onDisclosure(address(uint160(log_.topic2)), bytes32(log_.topic3), verdict);
        } else if (log_.topic0 == WARRANT_SET_TOPIC && log_.contractAddress == registry && log_.opCode == 3) {
            _watch(address(uint160(log_.topic2)));
        } else if (log_.topic0 == UNFROZEN_TOPIC && log_.contractAddress == guardian && log_.opCode == 2) {
            address agent = address(uint160(log_.topic1));
            freezeRequested[agent] = false;
            unusedDisclosures[agent] = 0;
            lastWasFail[agent] = false;
            emit Reset(agent);
        }
        // Anything else falls through: reverting here would still be billed.
    }

    function _watch(address agent) internal {
        if (watched[agent]) return;
        watched[agent] = true;
        SYSTEM.subscribe(
            originChainId, asset, TRANSFER_TOPIC, uint256(uint160(agent)), REACTIVE_IGNORE, REACTIVE_IGNORE
        );
        emit Watching(agent);
    }

    function _onDisclosure(address agent, bytes32 quoteHash, uint8 verdict) internal {
        if (verdict == VERDICT_FAIL) {
            lastWasFail[agent] = true;
        } else {
            lastWasFail[agent] = false;
            unusedDisclosures[agent] += 1;
        }
        emit Disclosure(agent, quoteHash, verdict, unusedDisclosures[agent]);
    }

    function _onOutflow(LogRecord calldata log_) internal {
        address agent = address(uint160(log_.topic1));
        address to = address(uint160(log_.topic2));
        if (!watched[agent] || to == guardian || freezeRequested[agent]) return;
        uint256 amount = abi.decode(log_.data, (uint256));

        uint256 unused = unusedDisclosures[agent];
        if (unused > 0) {
            unusedDisclosures[agent] = unused - 1;
            emit TradeCovered(agent, amount, unused - 1, log_.txHash);
            return;
        }

        uint8 reason = lastWasFail[agent] ? REASON_TRADED_AFTER_FAIL : REASON_UNDISCLOSED;
        freezeRequested[agent] = true;
        emit Violation(agent, reason, amount, log_.txHash);
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: originChainId,
                recipient: guardian,
                gasLimit: CALLBACK_GAS_LIMIT,
                payload: abi.encodeWithSignature(
                    "freeze(address,address,uint8,uint256,uint256)",
                    address(0),
                    agent,
                    reason,
                    originChainId,
                    log_.txHash
                )
            })
        );
    }
}
