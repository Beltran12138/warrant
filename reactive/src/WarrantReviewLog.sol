// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {WarrantGuardian} from "./WarrantGuardian.sol";

/// @title WarrantReviewLog
/// @notice Where an AI reviewer files its reading of a freeze. When WarrantGuardian freezes an agent (the
///         Reactive callback lands), an off-chain model is triggered by the `Frozen` event, reads the on-chain
///         evidence and recommends what the owner should do. The recommendation is recorded here, next to the
///         freeze it is about, with a hash of the full report.
/// @dev    Advisory only: nothing here can move funds or lift a freeze. Only a reviewer the guardian's owner
///         appointed can file, and only while the agent is actually frozen.
contract WarrantReviewLog {
    enum Recommendation {
        KeepFrozen, // e.g. funds went somewhere the agent never traded with: treat the key as compromised
        UnfreezeWithLowerBudget, // e.g. a process failure: restore preflight, then resume small
        Unfreeze // the freeze looks like a false alarm
    }

    /// guardian => reviewer => appointed
    mapping(address => mapping(address => bool)) public isReviewer;

    event ReviewerSet(address indexed guardian, address indexed reviewer, bool appointed);
    event Reviewed(
        address indexed guardian,
        address indexed agent,
        bytes32 indexed frozenTx,
        address reviewer,
        Recommendation recommendation,
        uint256 suggestedBudget,
        bytes32 reportHash,
        string summary
    );

    error NotGuardianOwner();
    error NotReviewer();
    error NotFrozen();

    function setReviewer(WarrantGuardian guardian, address reviewer, bool appointed) external {
        if (msg.sender != guardian.owner()) revert NotGuardianOwner();
        isReviewer[address(guardian)][reviewer] = appointed;
        emit ReviewerSet(address(guardian), reviewer, appointed);
    }

    /// @param frozenTx      the transaction in which the guardian emitted `Frozen` (the callback)
    /// @param reportHash    keccak256 of the full report the reviewer produced (kept off chain)
    /// @param summary       a short plain-language summary for the owner
    function review(
        WarrantGuardian guardian,
        address agent,
        bytes32 frozenTx,
        Recommendation recommendation,
        uint256 suggestedBudget,
        bytes32 reportHash,
        string calldata summary
    ) external {
        if (!isReviewer[address(guardian)][msg.sender]) revert NotReviewer();
        if (!guardian.frozen(agent)) revert NotFrozen();
        emit Reviewed(address(guardian), agent, frozenTx, msg.sender, recommendation, suggestedBudget, reportHash, summary);
    }
}
