// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WarrantRegistry} from "./WarrantRegistry.sol";
import {WarrantAttestor} from "./WarrantAttestor.sol";
import {IERC8004Identity, IERC8004Reputation} from "./WarrantReputation.sol";

/// Minimal Chainlink Data Feeds (AggregatorV3Interface) slice.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title WarrantPriceCheck
/// @notice Re-checks an agent's signed preflight disclosure against Chainlink Data Feeds. Every other
///         number in a Warrant scorecard is computed by the agent's own plugin; this contract prices the
///         disclosed quote independently, on chain, and records whether the agent's verdict survives.
/// @dev    The quote terms are bound by the agent's signature without a second one: for checkable
///         disclosures the attestation's quoteHash is `termsHash(terms)`, so a relayer cannot swap in
///         different amounts. The check compares the quoted output with the oracle-fair output:
///             shortfallBps = (fairOut - quotedOut) / fairOut, in bps (0 if the quote beats the oracle)
///         against the warrant's all-in cost budget, maxPriceImpactBps + maxFeeBps, plus `toleranceBps`
///         for oracle lag (a Chainlink feed only updates when the price moves past its deviation threshold,
///         so the price it reports can be that far off; the tolerance is set to the sum of both feeds'
///         thresholds at deployment). Gas paid outside the quote is not in quotedOut, so it is not counted.
///         Reveal, don't enforce: nothing here blocks a trade. A stale feed reverts, because an unpriceable
///         quote must not be recorded as checked. The feed set is fixed at deployment; there is no admin.
contract WarrantPriceCheck {
    struct QuoteTerms {
        bytes32 quoteIdHash; // keccak256 of the swap quote id
        address sellToken; // address(0) = the chain's native coin
        address buyToken;
        uint256 sellAmount; // base units
        uint256 buyAmount; // quoted output, base units
    }

    struct Feed {
        IAggregatorV3 aggregator;
        uint8 tokenDecimals;
        uint32 maxAge; // seconds since the last update before the price counts as stale
    }

    WarrantAttestor public immutable attestor;
    WarrantRegistry public immutable registry;
    IERC8004Identity public immutable identity;
    IERC8004Reputation public immutable reputation;
    uint16 public immutable toleranceBps;

    string public constant TAG = "warrant-oracle";

    mapping(address => Feed) public feeds;
    /// attestation digest => already checked
    mapping(bytes32 => bool) public checked;

    event PriceChecked(
        bytes32 indexed digest,
        address indexed agent,
        address indexed principal,
        uint256 fairOut,
        uint256 quotedOut,
        uint256 shortfallBps,
        uint256 budgetBps,
        bool outOfBounds,
        bool contradicted
    );
    event PriceCheckRated(uint256 indexed agentId, bytes32 indexed digest, bool contradicted);

    error LengthMismatch();
    error NoFeed(address token);
    error StaleFeed(address token, uint256 updatedAt);
    error BadPrice(address token, int256 answer);
    error TermsMismatch(bytes32 quoteHash, bytes32 termsHash);
    error NotAttested(bytes32 digest);
    error AlreadyChecked(bytes32 digest);
    error NotAgentWallet(uint256 agentId, address agentWallet, address agent);

    constructor(
        WarrantAttestor attestor_,
        IERC8004Identity identity_,
        IERC8004Reputation reputation_,
        uint16 toleranceBps_,
        address[] memory tokens,
        IAggregatorV3[] memory aggregators,
        uint8[] memory tokenDecimals,
        uint32[] memory maxAges
    ) {
        if (tokens.length != aggregators.length || tokens.length != tokenDecimals.length || tokens.length != maxAges.length) {
            revert LengthMismatch();
        }
        attestor = attestor_;
        registry = attestor_.registry();
        identity = identity_;
        reputation = reputation_;
        toleranceBps = toleranceBps_;
        for (uint256 i; i < tokens.length; ++i) {
            feeds[tokens[i]] = Feed(aggregators[i], tokenDecimals[i], maxAges[i]);
        }
    }

    function termsHash(QuoteTerms calldata t) public pure returns (bytes32) {
        return keccak256(abi.encode(t.quoteIdHash, t.sellToken, t.buyToken, t.sellAmount, t.buyAmount));
    }

    /// @notice Oracle-fair output for selling `sellAmount` of `sellToken` into `buyToken`, in buyToken base units.
    function fairOut(address sellToken, address buyToken, uint256 sellAmount) public view returns (uint256) {
        (uint256 pSell, uint8 dSell, uint8 tSell) = _price(sellToken);
        (uint256 pBuy, uint8 dBuy, uint8 tBuy) = _price(buyToken);
        return (sellAmount * pSell * 10 ** (uint256(tBuy) + dBuy)) / (pBuy * 10 ** (uint256(tSell) + dSell));
    }

    /// @notice Price an attested disclosure against the oracle and record the outcome.
    function check(WarrantAttestor.PreflightAttestation calldata a, QuoteTerms calldata t)
        public
        returns (bytes32 d, bool contradicted)
    {
        bytes32 th = termsHash(t);
        if (a.quoteHash != th) revert TermsMismatch(a.quoteHash, th);
        d = attestor.digest(a);
        if (!attestor.submitted(d)) revert NotAttested(d);
        if (checked[d]) revert AlreadyChecked(d);

        checked[d] = true;
        contradicted = _assess(d, a, t);
    }

    function _assess(bytes32 d, WarrantAttestor.PreflightAttestation calldata a, QuoteTerms calldata t)
        private
        returns (bool contradicted)
    {
        (WarrantRegistry.Warrant memory w, uint32 version,) = registry.getWarrant(a.principal, a.agent);
        if (version != a.warrantVersion) revert WarrantRegistry.StaleWarrantVersion(version, a.warrantVersion);

        uint256 fair = fairOut(t.sellToken, t.buyToken, t.sellAmount);
        uint256 shortfall = fair > t.buyAmount ? ((fair - t.buyAmount) * 10_000) / fair : 0;
        uint256 budget = uint256(w.maxPriceImpactBps) + w.maxFeeBps;
        bool out = shortfall > budget + toleranceBps;
        contradicted = out && a.verdict == uint8(WarrantRegistry.Verdict.Pass);
        emit PriceChecked(d, a.agent, a.principal, fair, t.buyAmount, shortfall, budget, out, contradicted);
    }

    /// @notice `check`, then one ERC-8004 feedback entry on the agent's identity: tag1 "warrant-oracle",
    ///         tag2 "consistent" (value 1) or "contradicted" (value -1), feedbackHash the attestation digest.
    function checkAndRate(WarrantAttestor.PreflightAttestation calldata a, QuoteTerms calldata t, uint256 agentId)
        external
        returns (bytes32 d, bool contradicted)
    {
        bytes memory raw = identity.getMetadata(agentId, "agentWallet");
        address wallet = raw.length == 20 ? address(bytes20(raw)) : address(0);
        if (wallet != a.agent) revert NotAgentWallet(agentId, wallet, a.agent);
        (d, contradicted) = check(a, t);
        reputation.giveFeedback(
            agentId, contradicted ? int128(-1) : int128(1), 0, TAG, contradicted ? "contradicted" : "consistent", "", "", d
        );
        emit PriceCheckRated(agentId, d, contradicted);
    }

    function _price(address token) private view returns (uint256 price, uint8 feedDecimals, uint8 tokenDecimals) {
        Feed memory f = feeds[token];
        if (address(f.aggregator) == address(0)) revert NoFeed(token);
        (, int256 answer,, uint256 updatedAt,) = f.aggregator.latestRoundData();
        if (answer <= 0) revert BadPrice(token, answer);
        if (block.timestamp > updatedAt + f.maxAge) revert StaleFeed(token, updatedAt);
        return (uint256(answer), f.aggregator.decimals(), f.tokenDecimals);
    }
}
