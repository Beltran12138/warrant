// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WarrantAttestor} from "./WarrantAttestor.sol";

/// Minimal slices of the ERC-8004 v2.0.0 registries (https://eips.ethereum.org/EIPS/eip-8004).
interface IERC8004Identity {
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);
}

interface IERC8004Reputation {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

/// @title WarrantReputation
/// @notice Turns verified Warrant preflight attestations into ERC-8004 reputation. Each agent-signed
///         attestation that passes WarrantAttestor's checks becomes one feedback entry on the agent's
///         ERC-8004 identity: value 1, tag1 "warrant-preflight", tag2 the verdict ("pass" | "warn" |
///         "fail"), feedbackHash the attestation digest. `getSummary(agentId, [this], "warrant-preflight", "")`
///         then counts the agent's verified pre-trade disclosures; with tag2 "fail", the trades it
///         disclosed as out of bounds.
/// @dev    The agent address in the attestation must be the `agentWallet` of the ERC-8004 identity,
///         which the identity registry only sets with that wallet's own EIP-712 signature. This
///         contract is the feedback client, so it must not own or operate any agent it rates.
///         What the count measures is disclosure, not trading skill; a principal is just an address,
///         so consumers should weigh attestations by principal (see the SignedPreflightAttested events).
contract WarrantReputation {
    WarrantAttestor public immutable attestor;
    IERC8004Identity public immutable identity;
    IERC8004Reputation public immutable reputation;

    string public constant TAG = "warrant-preflight";

    /// attestation digest => already turned into feedback
    mapping(bytes32 => bool) public rated;

    event AttestationRated(uint256 indexed agentId, address indexed agent, bytes32 indexed digest, uint8 verdict, address relayer);

    error NotAgentWallet(uint256 agentId, address agentWallet, address agent);
    error AlreadyRated(bytes32 digest);

    constructor(WarrantAttestor attestor_, IERC8004Identity identity_, IERC8004Reputation reputation_) {
        attestor = attestor_;
        identity = identity_;
        reputation = reputation_;
    }

    /// @notice Record `a` in WarrantAttestor (unless someone already did) and rate the agent once.
    /// @param signature the agent's EIP-712 signature; ignored if the attestation is already recorded,
    ///                  since WarrantAttestor only records attestations whose signature it verified.
    function submitAndRate(WarrantAttestor.PreflightAttestation calldata a, bytes calldata signature, uint256 agentId)
        external
    {
        address wallet = _agentWallet(agentId);
        if (wallet != a.agent) revert NotAgentWallet(agentId, wallet, a.agent);

        bytes32 d = attestor.digest(a);
        if (rated[d]) revert AlreadyRated(d);
        if (!attestor.submitted(d)) attestor.submit(a, signature);
        rated[d] = true;

        reputation.giveFeedback(agentId, 1, 0, TAG, _verdict(a.verdict), "", "", d);
        emit AttestationRated(agentId, a.agent, d, a.verdict, msg.sender);
    }

    function _agentWallet(uint256 agentId) private view returns (address) {
        bytes memory w = identity.getMetadata(agentId, "agentWallet");
        return w.length == 20 ? address(bytes20(w)) : address(0);
    }

    function _verdict(uint8 v) private pure returns (string memory) {
        return v == 0 ? "pass" : v == 1 ? "warn" : "fail"; // attestor rejects anything above 2
    }
}
