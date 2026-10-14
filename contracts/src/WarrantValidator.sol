// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WarrantRegistry} from "./WarrantRegistry.sol";
import {WarrantAttestor} from "./WarrantAttestor.sol";
import {WarrantPriceCheck} from "./WarrantPriceCheck.sol";
import {IERC8004Identity} from "./WarrantReputation.sol";

/// Minimal slice of the ERC-8004 v2.0.0 ValidationRegistry.
interface IERC8004Validation {
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string memory tag, uint256 lastUpdate);
}

/// @title WarrantValidator
/// @notice An ERC-8004 validator for Warrant disclosures. The agent's owner asks ERC-8004's ValidationRegistry
///         to validate a disclosure (requestHash = the attestation digest, validator = this contract); anyone
///         can then call `respond`, which prices the disclosed quote with the same Chainlink feeds
///         WarrantPriceCheck uses and answers 100 (the verdict survives the oracle) or 0 (a PASS the oracle
///         puts out of bounds). The result is a credential an honest agent can show.
/// @dev    This is the opt-in half. Validation requests can only come from the agent's side, so a lying
///         agent would never ask; WarrantPriceCheck.checkAndRate (reputation, no consent needed) stays the way
///         to catch one. The rule here is WarrantPriceCheck's rule, computed from its `fairOut` and
///         `toleranceBps`, so the two can never disagree on the same disclosure. No admin, no state of its own.
contract WarrantValidator {
    WarrantPriceCheck public immutable priceCheck;
    WarrantAttestor public immutable attestor;
    WarrantRegistry public immutable registry;
    IERC8004Identity public immutable identity;
    IERC8004Validation public immutable validation;

    string public constant TAG = "warrant-oracle";

    event Validated(bytes32 indexed requestHash, uint256 indexed agentId, uint8 response, uint256 shortfallBps, uint256 budgetBps);

    error NotRequestedFromThisValidator(bytes32 requestHash, address validator);
    error TermsMismatch(bytes32 quoteHash, bytes32 termsHash);
    error NotAttested(bytes32 digest);
    error NotAgentWallet(uint256 agentId, address agentWallet, address agent);

    constructor(WarrantPriceCheck priceCheck_, IERC8004Validation validation_) {
        priceCheck = priceCheck_;
        attestor = priceCheck_.attestor();
        registry = priceCheck_.registry();
        identity = priceCheck_.identity();
        validation = validation_;
    }

    /// @notice Answer the validation request for disclosure `a` (requestHash must be its digest).
    function respond(WarrantAttestor.PreflightAttestation calldata a, WarrantPriceCheck.QuoteTerms calldata t)
        external
        returns (uint8 response)
    {
        bytes32 d = attestor.digest(a);
        (address validator, uint256 agentId,,,,) = validation.getValidationStatus(d); // reverts "unknown" if never requested
        if (validator != address(this)) revert NotRequestedFromThisValidator(d, validator);
        // The request names an agentId but the registry does not tie it to the disclosure: without this check,
        // any identity owner could collect a credential for someone else's honest disclosure.
        bytes memory raw = identity.getMetadata(agentId, "agentWallet");
        address wallet = raw.length == 20 ? address(bytes20(raw)) : address(0);
        if (wallet != a.agent) revert NotAgentWallet(agentId, wallet, a.agent);
        bytes32 th = priceCheck.termsHash(t);
        if (a.quoteHash != th) revert TermsMismatch(a.quoteHash, th);
        if (!attestor.submitted(d)) revert NotAttested(d);

        (uint256 shortfall, uint256 budget, bytes32 evidence) = _price(a, t);
        bool contradicted = shortfall > budget + priceCheck.toleranceBps() && a.verdict == uint8(WarrantRegistry.Verdict.Pass);
        response = contradicted ? 0 : 100;

        validation.validationResponse(d, response, "", evidence, TAG);
        emit Validated(d, agentId, response, shortfall, budget);
    }

    /// Same rule as WarrantPriceCheck: shortfall of the quoted output below the Chainlink-fair output, in bps,
    /// against the warrant's maxPriceImpactBps + maxFeeBps at the attested version.
    function _price(WarrantAttestor.PreflightAttestation calldata a, WarrantPriceCheck.QuoteTerms calldata t)
        private
        view
        returns (uint256 shortfall, uint256 budget, bytes32 evidence)
    {
        (WarrantRegistry.Warrant memory w, uint32 version,) = registry.getWarrant(a.principal, a.agent);
        if (version != a.warrantVersion) revert WarrantRegistry.StaleWarrantVersion(version, a.warrantVersion);
        uint256 fair = priceCheck.fairOut(t.sellToken, t.buyToken, t.sellAmount);
        shortfall = fair > t.buyAmount ? ((fair - t.buyAmount) * 10_000) / fair : 0;
        budget = uint256(w.maxPriceImpactBps) + w.maxFeeBps;
        evidence = keccak256(abi.encode(fair, t.buyAmount, shortfall, budget));
    }
}
