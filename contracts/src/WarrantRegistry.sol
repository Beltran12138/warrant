// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title WarrantRegistry
/// @notice On-chain, revocable trade warrants that a principal grants to an AI agent,
///         plus an append-only log of the preflight disclosures the agent saw before it traded.
/// @dev    Reveal, don't enforce: this contract never custodies funds and never blocks a trade.
///         It makes two things verifiable after the fact:
///           1. what the principal authorised (versioned, revocable, expiring warrant), and
///           2. that the agent was shown the trade's suitability scorecard under a given warrant
///              version before it executed (attestPreflight).
///         Field semantics mirror `WarrantSpec` in src/lib/score.ts of the mm plugin.
contract WarrantRegistry {
    /// @notice Suitability limits. Bps fields: 100 = 1%.
    struct Warrant {
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
        Warrant warrant;
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

    event WarrantSet(address indexed principal, address indexed agent, uint32 version, Warrant warrant);
    event WarrantRevoked(address indexed principal, address indexed agent, uint32 version);
    event PreflightAttested(
        address indexed principal,
        address indexed agent,
        bytes32 indexed quoteHash,
        uint32 warrantVersion,
        Verdict verdict,
        bytes32 scorecardHash
    );

    error ZeroAgent();
    error AlreadyExpired();
    error NoActiveWarrant();
    error StaleWarrantVersion(uint32 current, uint32 attested);

    /// @notice Grant or replace the warrant `agent` operates under for msg.sender.
    function setWarrant(address agent, Warrant calldata m) external returns (uint32 version) {
        if (agent == address(0)) revert ZeroAgent();
        if (m.expiresAt != 0 && m.expiresAt <= block.timestamp) revert AlreadyExpired();
        Record storage r = _records[msg.sender][agent];
        version = r.version + 1;
        r.warrant = m;
        r.version = version;
        r.revoked = false;
        emit WarrantSet(msg.sender, agent, version, m);
    }

    /// @notice Revoke the warrant msg.sender granted to `agent`.
    function revoke(address agent) external {
        Record storage r = _records[msg.sender][agent];
        if (r.version == 0 || r.revoked) revert NoActiveWarrant();
        r.version += 1;
        r.revoked = true;
        emit WarrantRevoked(msg.sender, agent, r.version);
    }

    /// @notice Read a warrant. `active` is false if never set, revoked, or expired.
    function getWarrant(address principal, address agent)
        external
        view
        returns (Warrant memory warrant, uint32 version, bool active)
    {
        Record storage r = _records[principal][agent];
        return (r.warrant, r.version, _isActive(r));
    }

    /// @notice Called by the agent (msg.sender) to log that it ran preflight on a quote under
    ///         the principal's current warrant version. Emits only; stores nothing per quote.
    /// @param quoteHash      keccak256 of the swap quote id (or quote payload) that was checked.
    /// @param warrantVersion the version the scorecard was computed against; must be current.
    /// @param scorecardHash  keccak256 of the canonical scorecard JSON shown to agent / human.
    function attestPreflight(
        address principal,
        bytes32 quoteHash,
        uint32 warrantVersion,
        Verdict verdict,
        bytes32 scorecardHash
    ) external {
        Record storage r = _records[principal][msg.sender];
        if (!_isActive(r)) revert NoActiveWarrant();
        if (warrantVersion != r.version) revert StaleWarrantVersion(r.version, warrantVersion);
        emit PreflightAttested(principal, msg.sender, quoteHash, warrantVersion, verdict, scorecardHash);
    }

    function _isActive(Record storage r) private view returns (bool) {
        if (r.version == 0 || r.revoked) return false;
        uint64 exp = r.warrant.expiresAt;
        return exp == 0 || exp > block.timestamp;
    }
}
