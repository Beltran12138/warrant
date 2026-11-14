// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {WarrantRegistry} from "warrant/WarrantRegistry.sol";

/// @title WarrantGuardian
/// @notice The principal's side of Warrant, as a contract. It holds the funds an AI agent may trade
///         with, grants the agent its Warrant in its own name (so it can also revoke it), and lets the
///         agent draw from a budget while that Warrant is active.
/// @dev    Warrant on its own reveals and does not enforce: an agent can trade without running
///         preflight, and only an off-chain audit notices. Here, WarrantSentinel (a reactive contract
///         on Reactive Network) watches the agent's trades and disclosures and, on the first trade the
///         agent did not disclose as PASS or WARN, calls `freeze` through the Reactive callback proxy.
///         Freezing sets the agent's budget to zero and revokes its Warrant, so the damage is bounded
///         by what the agent had already drawn. Nothing here intercepts the agent's wallet: the agent
///         trades from its own wallet with ordinary tools, and the consequence lands on its funding.
contract WarrantGuardian is AbstractCallback {
    using SafeERC20 for IERC20;

    /// @notice Why the sentinel froze an agent. Must match WarrantSentinel.
    enum Reason {
        Undisclosed, // a trade with no unused PASS/WARN disclosure in front of it
        TradedAfterFail // the agent's latest disclosure was FAIL and it traded anyway
    }

    address public immutable owner;
    WarrantRegistry public immutable registry;
    IERC20 public immutable asset;

    /// agent => amount it may still draw
    mapping(address => uint256) public budget;
    /// agent => frozen by the sentinel (cleared only by the owner)
    mapping(address => bool) public frozen;

    event BudgetSet(address indexed agent, uint256 amount);
    event Drawn(address indexed agent, uint256 amount, uint256 remaining);
    event Frozen(
        address indexed agent,
        Reason reason,
        uint256 originChainId,
        uint256 originTxHash,
        uint256 budgetCut,
        bool warrantRevoked
    );
    event Unfrozen(address indexed agent);

    error NotOwner();
    error AgentFrozen(address agent);
    error NoActiveWarrant(address agent);
    error OverBudget(uint256 requested, uint256 available);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param callbackProxy_ Reactive callback proxy on this chain (pays for and delivers callbacks).
    /// @param sentinel_      WarrantSentinel on Reactive Network: the only contract allowed to freeze.
    constructor(IPayable callbackProxy_, address sentinel_, WarrantRegistry registry_, IERC20 asset_, address owner_)
        payable
        AbstractCallback(callbackProxy_, sentinel_)
    {
        registry = registry_;
        asset = asset_;
        owner = owner_;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Grant (or replace) the Warrant `agent` trades under. The guardian is the principal.
    function setWarrant(address agent, WarrantRegistry.Warrant calldata m) external onlyOwner returns (uint32) {
        return registry.setWarrant(agent, m);
    }

    function setBudget(address agent, uint256 amount) external onlyOwner {
        budget[agent] = amount;
        emit BudgetSet(agent, amount);
    }

    /// @notice Lift a freeze. The Warrant stays revoked until the owner grants a new one.
    function unfreeze(address agent) external onlyOwner {
        frozen[agent] = false;
        emit Unfrozen(agent);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        asset.safeTransfer(to, amount);
    }

    /// @notice Settle any callback debt from this contract's native balance (anyone may top up and call).
    function coverDebt() external {
        _coverDebt();
    }

    // ---------------------------------------------------------------- agent

    /// @notice The agent draws trading funds to its own wallet.
    function draw(uint256 amount) external {
        address agent = msg.sender;
        if (frozen[agent]) revert AgentFrozen(agent);
        (,, bool active) = registry.getWarrant(address(this), agent);
        if (!active) revert NoActiveWarrant(agent);
        uint256 left = budget[agent];
        if (amount > left) revert OverBudget(amount, left);
        unchecked {
            left -= amount;
        }
        budget[agent] = left;
        asset.safeTransfer(agent, amount);
        emit Drawn(agent, amount, left);
    }

    // ---------------------------------------------------------------- callback

    /// @notice Called by the Reactive callback proxy on behalf of WarrantSentinel.
    /// @param rvm_ Overwritten by Reactive Network with the requesting reactive contract's address.
    /// @dev    Never reverts on a valid caller: a failed callback is still billed, and freezing twice
    ///         must be harmless (the sentinel may see two violations before the first callback lands).
    function freeze(address rvm_, address agent, Reason reason, uint256 originChainId, uint256 originTxHash)
        external
        onlyServiceProvider
        onlyCallbackSender(rvm_)
    {
        if (frozen[agent]) return;
        frozen[agent] = true;
        uint256 cut = budget[agent];
        budget[agent] = 0;
        (,, bool active) = registry.getWarrant(address(this), agent);
        if (active) registry.revoke(agent);
        emit Frozen(agent, reason, originChainId, originTxHash, cut, active);
    }
}
