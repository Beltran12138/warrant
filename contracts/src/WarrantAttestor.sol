// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WarrantRegistry} from "./WarrantRegistry.sol";

/// @title WarrantAttestor
/// @notice Puts an agent's *signed* preflight attestation on-chain. The agent signs EIP-712 typed data
///         off-chain (no gas, no transaction; with MetaMask Agent Wallet: `mm wallet sign-typed-data`);
///         anyone can then submit it here. The result is the same evidence as
///         WarrantRegistry.attestPreflight, without the agent having to send a transaction.
/// @dev    Reads warrants from an existing WarrantRegistry and never writes to it, so the registry
///         and its address stay unchanged. The signer must be the agent the warrant was granted to;
///         the submitter is recorded but not trusted. Each signed attestation can be submitted once.
contract WarrantAttestor {
    struct PreflightAttestation {
        address principal;
        address agent;
        bytes32 quoteHash;
        uint32 warrantVersion;
        uint8 verdict; // WarrantRegistry.Verdict: 0 Pass, 1 Warn, 2 Fail
        bytes32 scorecardHash;
    }

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "PreflightAttestation(address principal,address agent,bytes32 quoteHash,uint32 warrantVersion,uint8 verdict,bytes32 scorecardHash)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// secp256k1n / 2: signatures with a higher s are the malleable twin of a valid one.
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    WarrantRegistry public immutable registry;
    /// digest => already submitted
    mapping(bytes32 => bool) public submitted;

    event SignedPreflightAttested(
        address indexed principal,
        address indexed agent,
        bytes32 indexed quoteHash,
        uint32 warrantVersion,
        uint8 verdict,
        bytes32 scorecardHash,
        address submitter
    );

    error InvalidVerdict(uint8 verdict);
    error BadSignature();
    error NotSignedByAgent(address signer, address agent);
    error AlreadySubmitted(bytes32 digest);

    constructor(WarrantRegistry registry_) {
        registry = registry_;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Warrant"), keccak256("1"), block.chainid, address(this)));
    }

    /// @notice EIP-712 digest the agent signs for `a`.
    function digest(PreflightAttestation calldata a) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(ATTESTATION_TYPEHASH, a.principal, a.agent, a.quoteHash, a.warrantVersion, a.verdict, a.scorecardHash)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Put a signed attestation on-chain. Reverts unless the agent signed it and the
    ///         principal's warrant for that agent is active at exactly `a.warrantVersion`.
    function submit(PreflightAttestation calldata a, bytes calldata signature) external {
        if (a.verdict > uint8(WarrantRegistry.Verdict.Fail)) revert InvalidVerdict(a.verdict);
        bytes32 d = digest(a);
        if (submitted[d]) revert AlreadySubmitted(d);
        address signer = _recover(d, signature);
        if (signer != a.agent) revert NotSignedByAgent(signer, a.agent);

        (, uint32 version, bool active) = registry.getWarrant(a.principal, a.agent);
        if (!active) revert WarrantRegistry.NoActiveWarrant();
        if (version != a.warrantVersion) revert WarrantRegistry.StaleWarrantVersion(version, a.warrantVersion);

        submitted[d] = true;
        emit SignedPreflightAttested(a.principal, a.agent, a.quoteHash, a.warrantVersion, a.verdict, a.scorecardHash, msg.sender);
    }

    function _recover(bytes32 d, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(d, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
