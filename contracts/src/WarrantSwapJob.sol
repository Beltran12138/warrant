// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ERC8183} from "./vendor/erc8183/ERC8183.sol";
import {IERC8183Hook} from "./vendor/erc8183/IERC8183Hook.sol";
import {WarrantRegistry} from "./WarrantRegistry.sol";
import {WarrantAttestor} from "./WarrantAttestor.sol";
import {WarrantPriceCheck} from "./WarrantPriceCheck.sol";

/// @title WarrantSwapJob
/// @notice ERC-8183 hook and evaluator for "swap this for me" jobs, settled against the agent's warrant and
///         Chainlink. The client (who is also the agent's Warrant principal) hires the agent (the job's
///         provider) to convert `sellAmount` of one token into another. The hook hands the agent the capital
///         when the job is funded; to submit, the agent must deposit what it actually got and attach the Warrant
///         disclosure it signed for the quote. Anyone can then call `settle`, which decides on chain:
///           - delivered output vs the Chainlink-fair output, against the warrant's price-impact + fee budget
///             plus WarrantPriceCheck's oracle tolerance;
///           - delivered output vs the output the agent disclosed, against the warrant's slippage limit
///             (the disclosure is the quote, the deposit is the execution: this links the two);
///           - a disclosed FAIL that was traded anyway, or a warrant no longer active, rejects.
///         Pass completes the job (the agent is paid its fee); otherwise it is rejected (the fee goes back to
///         the client). Either way the delivered tokens go to the buyer: the capital was the client's.
/// @dev    Unlike the reference FundTransferHook (same token, same amount back), the output token and amount
///         differ from the input. Arc: native USDC (address(0), 18 decimals, as WarrantPriceCheck prices it) and
///         its ERC-20 interface `usdcErc20` (6 decimals) are one balance; the hook moves the ERC-20 and prices it
///         as native. No admin. Only the job's own core contract can call the hook functions.
contract WarrantSwapJob is IERC8183Hook {
    using SafeERC20 for IERC20;

    struct Order {
        address sellToken; // ERC-20 the client provides
        uint256 sellAmount;
        address buyToken; // ERC-20 the agent must deliver
        address buyer; // receives the delivered tokens
        bool funded; // capital handed to the agent
        bool delivered; // output escrowed here
        uint256 outAmount;
        bytes32 disclosure; // the agent's Warrant attestation digest
        uint32 warrantVersion;
        uint8 verdict; // disclosed verdict
        uint256 quotedOut; // disclosed output, buyToken base units
    }

    ERC8183 public immutable core;
    WarrantPriceCheck public immutable priceCheck;
    WarrantAttestor public immutable attestor;
    WarrantRegistry public immutable registry;
    address public immutable usdcErc20;

    mapping(uint256 => Order) public orders;

    event OrderPlaced(uint256 indexed jobId, address sellToken, uint256 sellAmount, address buyToken, address buyer);
    event Delivered(uint256 indexed jobId, bytes32 indexed disclosure, uint256 outAmount, uint256 quotedOut);
    event Settled(
        uint256 indexed jobId,
        bytes32 indexed disclosure,
        bool paid,
        uint256 fairOut,
        uint256 outAmount,
        uint256 shortfallBps,
        uint256 budgetBps,
        uint256 slippageBps,
        uint256 maxSlippageBps
    );
    event Released(uint256 indexed jobId, address buyer, uint256 outAmount);

    error OnlyCore();
    error NotClient();
    error NotThisJob();
    error OrderExists();
    error BadOrder();
    error NoOrder();
    error NotFunded();
    error AlreadyDelivered();
    error NotDelivered();
    error DisclosureMismatch();
    error NotAttested(bytes32 digest);
    error WrongParties();
    error TermsMismatch();
    error ShortDeposit();
    error WrongStatus();

    constructor(ERC8183 core_, WarrantPriceCheck priceCheck_, address usdcErc20_) {
        core = core_;
        priceCheck = priceCheck_;
        attestor = priceCheck_.attestor();
        registry = priceCheck_.registry();
        usdcErc20 = usdcErc20_;
    }

    modifier onlyCore() {
        if (msg.sender != address(core)) revert OnlyCore();
        _;
    }

    // ─────────────────────────── client ───────────────────────────

    /// @notice The client states the order before funding: what it sells, how much, what it wants back.
    function placeOrder(uint256 jobId, address sellToken, uint256 sellAmount, address buyToken, address buyer) external {
        ERC8183.Job memory job = core.getJob(jobId);
        if (msg.sender != job.client) revert NotClient();
        if (job.hook != address(this) || job.evaluator != address(this)) revert NotThisJob();
        if (job.status != ERC8183.JobStatus.Open) revert WrongStatus();
        if (orders[jobId].sellToken != address(0)) revert OrderExists();
        if (sellToken == address(0) || buyToken == address(0) || buyer == address(0) || sellAmount == 0 || sellToken == buyToken) {
            revert BadOrder();
        }
        orders[jobId].sellToken = sellToken;
        orders[jobId].sellAmount = sellAmount;
        orders[jobId].buyToken = buyToken;
        orders[jobId].buyer = buyer;
        emit OrderPlaced(jobId, sellToken, sellAmount, buyToken, buyer);
    }

    // ─────────────────────────── hook ───────────────────────────

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyCore {
        if (selector == ERC8183.fund.selector) {
            if (orders[jobId].sellToken == address(0)) revert NoOrder();
        } else if (selector == ERC8183.submit.selector) {
            _deliver(jobId, data);
        }
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata) external onlyCore {
        if (selector == ERC8183.fund.selector) {
            Order storage o = orders[jobId];
            ERC8183.Job memory job = core.getJob(jobId);
            o.funded = true;
            IERC20(o.sellToken).safeTransferFrom(job.client, job.provider, o.sellAmount);
        } else if (selector == ERC8183.complete.selector || selector == ERC8183.reject.selector) {
            _release(jobId);
        }
    }

    /// @dev submit optParams = abi.encode(attestation, terms, outAmount); deliverable = the attestation digest.
    function _deliver(uint256 jobId, bytes calldata data) private {
        Order storage o = orders[jobId];
        if (!o.funded) revert NotFunded();
        if (o.delivered) revert AlreadyDelivered();
        (address actor, bytes32 deliverable, bytes memory optParams) = abi.decode(data, (address, bytes32, bytes));
        (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t, uint256 outAmount) =
            abi.decode(optParams, (WarrantAttestor.PreflightAttestation, WarrantPriceCheck.QuoteTerms, uint256));

        _checkDisclosure(jobId, o, actor, deliverable, a, t);

        o.delivered = true;
        o.outAmount = outAmount;
        o.disclosure = deliverable;
        o.warrantVersion = a.warrantVersion;
        o.verdict = a.verdict;
        o.quotedOut = t.buyAmount;
        uint256 before = IERC20(o.buyToken).balanceOf(address(this));
        IERC20(o.buyToken).safeTransferFrom(actor, address(this), outAmount);
        if (IERC20(o.buyToken).balanceOf(address(this)) - before != outAmount) revert ShortDeposit();
        emit Delivered(jobId, deliverable, outAmount, t.buyAmount);
    }

    function _checkDisclosure(
        uint256 jobId,
        Order storage o,
        address actor,
        bytes32 deliverable,
        WarrantAttestor.PreflightAttestation memory a,
        WarrantPriceCheck.QuoteTerms memory t
    ) private view {
        if (attestor.digest(a) != deliverable) revert DisclosureMismatch();
        if (!attestor.submitted(deliverable)) revert NotAttested(deliverable);
        if (a.agent != actor || a.principal != core.getJob(jobId).client) revert WrongParties();
        if (priceCheck.termsHash(t) != a.quoteHash) revert TermsMismatch();
        (address pSell, uint256 pAmount) = _pricing(o.sellToken, o.sellAmount);
        if (t.sellToken != pSell || t.sellAmount != pAmount || t.buyToken != o.buyToken) revert TermsMismatch();
    }

    // ─────────────────────────── evaluator ───────────────────────────

    struct Assessment {
        bool paid;
        uint256 fairOut;
        uint256 shortfallBps;
        uint256 budgetBps;
        uint256 slippageBps;
        uint256 maxSlippageBps;
        bool warrantOk; // active and still at the disclosed version
        bool tradedAgainstFail; // the agent disclosed FAIL and delivered anyway
    }

    /// @notice What `settle` would decide right now (reverts if a Chainlink feed is stale).
    function preview(uint256 jobId) public view returns (Assessment memory r) {
        Order storage o = orders[jobId];
        if (!o.delivered) revert NotDelivered();
        ERC8183.Job memory job = core.getJob(jobId);
        (WarrantRegistry.Warrant memory w, uint32 version, bool active) = registry.getWarrant(job.client, job.provider);
        (address pSell, uint256 pAmount) = _pricing(o.sellToken, o.sellAmount);
        r.fairOut = priceCheck.fairOut(pSell, o.buyToken, pAmount);
        r.shortfallBps = _shortBps(r.fairOut, o.outAmount);
        r.budgetBps = uint256(w.maxPriceImpactBps) + w.maxFeeBps;
        r.slippageBps = _shortBps(o.quotedOut, o.outAmount);
        r.maxSlippageBps = w.maxSlippageBps;
        r.warrantOk = active && version == o.warrantVersion;
        r.tradedAgainstFail = o.verdict == uint8(WarrantRegistry.Verdict.Fail);
        r.paid = r.warrantOk && !r.tradedAgainstFail && r.shortfallBps <= r.budgetBps + priceCheck.toleranceBps()
            && r.slippageBps <= r.maxSlippageBps;
    }

    /// @notice Decide the job from chain data alone. Anyone can call once the agent has delivered.
    function settle(uint256 jobId) external returns (bool paid) {
        if (core.getJob(jobId).status != ERC8183.JobStatus.Submitted) revert WrongStatus();
        Assessment memory r = preview(jobId);
        Order storage o = orders[jobId];
        bytes32 reason = keccak256(abi.encode(o.disclosure, r.fairOut, o.outAmount, r.shortfallBps, r.slippageBps));
        emit Settled(jobId, o.disclosure, r.paid, r.fairOut, o.outAmount, r.shortfallBps, r.budgetBps, r.slippageBps, r.maxSlippageBps);
        paid = r.paid;
        if (paid) core.complete(jobId, reason, "");
        else core.reject(jobId, reason, "");
    }

    /// @notice After expiry (claimRefund is not hookable), hand delivered tokens to the buyer.
    function releaseExpired(uint256 jobId) external {
        if (core.getJob(jobId).status != ERC8183.JobStatus.Expired) revert WrongStatus();
        _release(jobId);
    }

    // ─────────────────────────── internals ───────────────────────────

    function _release(uint256 jobId) private {
        Order memory o = orders[jobId];
        delete orders[jobId];
        if (!o.delivered || o.outAmount == 0) return;
        IERC20(o.buyToken).safeTransfer(o.buyer, o.outAmount);
        emit Released(jobId, o.buyer, o.outAmount);
    }

    /// The (token, amount) WarrantPriceCheck prices: Arc's ERC-20 USDC is priced as native USDC (18 decimals).
    function _pricing(address token, uint256 amount) private view returns (address, uint256) {
        return token == usdcErc20 ? (address(0), amount * 1e12) : (token, amount);
    }

    function _shortBps(uint256 reference_, uint256 actual) private pure returns (uint256) {
        return reference_ > actual ? ((reference_ - actual) * 10_000) / reference_ : 0;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC8183Hook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
