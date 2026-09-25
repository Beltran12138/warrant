// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MandateRegistry
/// @notice On-chain, revocable trade mandates that a principal grants to an AI agent,
///         plus an append-only log of the preflight disclosures the agent saw before it traded.
/// @dev    Reveal, don't enforce: this contract never custodies funds and never blocks a trade.
///         It makes two things verifiable after the fact:
///           1. what the principal authorised (versioned, revocable, expiring mandate), and
///           2. that the agent was shown the trade's suitability scorecard under a given mandate
///              version before it executed (attestPreflight).
///         Field semantics mirror `MandateSpec` in src/lib/score.ts of the mm plugin.
contract MandateRegistry {
    /// @notice Suitability limits. Bps fields: 100 = 1%.
    struct Mandate {
        uint64 maxUsdPerTradeCents; // per-trade notional cap, USD * 100
        uint16 maxSlippageBps;
        uint16 maxPriceImpactBps;
        uint16 maxFeeBps;
        bool allowCrossChain;
        bool allowNewApproval;
        bool recipientMustBeSelf;
        uint64 expiresAt; // unix seconds; 0 = no expiry
    }

    struct Record {
        Mandate mandate;
        uint32 version; // bumps on every set/revoke; 0 = never set
        bool revoked;
    }

    /// @notice Preflight outcome, same ordering as the plugin's Severity type.
    enum Verdict {
        Pass,
        Warn,
        Fail
    }

    /// principal => agent => record
    mapping(address => mapping(address => Record)) private _records;

    event MandateSet(address indexed principal, address indexed agent, uint32 version, Mandate mandate);
    event MandateRevoked(address indexed principal, address indexed agent, uint32 version);
    event PreflightAttested(
        address indexed principal,
        address indexed agent,
        bytes32 indexed quoteHash,
        uint32 mandateVersion,
        Verdict verdict,
        bytes32 scorecardHash
    );

    error ZeroAgent();
    error AlreadyExpired();
    error NoActiveMandate();
    error StaleMandateVersion(uint32 current, uint32 attested);

    /// @notice Grant or replace the mandate `agent` operates under for msg.sender.
    function setMandate(address agent, Mandate calldata m) external returns (uint32 version) {
        if (agent == address(0)) revert ZeroAgent();
        if (m.expiresAt != 0 && m.expiresAt <= block.timestamp) revert AlreadyExpired();
        Record storage r = _records[msg.sender][agent];
        version = r.version + 1;
        r.mandate = m;
        r.version = version;
        r.revoked = false;
        emit MandateSet(msg.sender, agent, version, m);
    }

    /// @notice Revoke the mandate msg.sender granted to `agent`.
    function revoke(address agent) external {
        Record storage r = _records[msg.sender][agent];
        if (r.version == 0 || r.revoked) revert NoActiveMandate();
        r.version += 1;
        r.revoked = true;
        emit MandateRevoked(msg.sender, agent, r.version);
    }

    /// @notice Read a mandate. `active` is false if never set, revoked, or expired.
    function getMandate(address principal, address agent)
        external
        view
        returns (Mandate memory mandate, uint32 version, bool active)
    {
        Record storage r = _records[principal][agent];
        return (r.mandate, r.version, _isActive(r));
    }

    /// @notice Called by the agent (msg.sender) to log that it ran preflight on a quote under
    ///         the principal's current mandate version. Emits only; stores nothing per quote.
    /// @param quoteHash      keccak256 of the swap quote id (or quote payload) that was checked.
    /// @param mandateVersion the version the scorecard was computed against; must be current.
    /// @param scorecardHash  keccak256 of the canonical scorecard JSON shown to agent / human.
    function attestPreflight(
        address principal,
        bytes32 quoteHash,
        uint32 mandateVersion,
        Verdict verdict,
        bytes32 scorecardHash
    ) external {
        Record storage r = _records[principal][msg.sender];
        if (!_isActive(r)) revert NoActiveMandate();
        if (mandateVersion != r.version) revert StaleMandateVersion(r.version, mandateVersion);
        emit PreflightAttested(principal, msg.sender, quoteHash, mandateVersion, verdict, scorecardHash);
    }

    function _isActive(Record storage r) private view returns (bool) {
        if (r.version == 0 || r.revoked) return false;
        uint64 exp = r.mandate.expiresAt;
        return exp == 0 || exp > block.timestamp;
    }
}
