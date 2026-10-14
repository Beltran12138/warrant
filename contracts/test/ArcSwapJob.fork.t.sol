// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {WarrantRegistry} from "../src/WarrantRegistry.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";
import {WarrantPriceCheck, IAggregatorV3} from "../src/WarrantPriceCheck.sol";
import {WarrantSwapJob} from "../src/WarrantSwapJob.sol";

/// Stand-in for Arc's ERC-20 USDC: the real one moves native balances through Arc protocol precompiles
/// (0x1800…0000 transfer, 0x1800…0001 isBlocklisted) that stock forge does not implement. Same 6 decimals;
/// the hook prices it as native USDC exactly as it would the real 0x3600… address.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin (fork stand-in)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// WarrantSwapJob on an Arc mainnet fork: the ERC-8183 reference implementation (vendored, behind a proxy),
/// the deployed WarrantPriceCheck / WarrantAttestor / WarrantRegistry, live Chainlink feeds, real USDC and EURC.
/// forge test --match-contract ArcSwapJobForkTest   (needs network access to the Arc RPC)
contract ArcSwapJobForkTest is Test {
    WarrantPriceCheck constant PC = WarrantPriceCheck(0xdF3fE689F0a3C74Ce299018cB573870769f04571);
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    address constant USDC_USD = 0x84EA90AC252Dc437031461836DB5164219147905;
    address constant EURC_USD = 0x361b95c10b76Ca3f35C686d423e43A951755Bf23;

    uint256 constant CAPITAL = 500_000; // 0.5 USDC
    uint256 constant FEE = 10_000; // 0.01 USDC service fee

    address USDC;
    ERC8183 core;
    WarrantSwapJob hook;
    WarrantAttestor att;
    WarrantRegistry reg;
    address client = makeAddr("client"); // also the agent's Warrant principal
    uint256 agentPk = 0xA11CE;
    address agent;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arc"));
        agent = vm.addr(agentPk);
        MockUSDC usdc = new MockUSDC();
        USDC = address(usdc);
        usdc.mint(makeAddr("client"), 10e6);
        att = PC.attestor();
        reg = PC.registry();
        ERC8183 impl = new ERC8183();
        core = ERC8183(address(new ERC1967Proxy(address(impl), abi.encodeCall(ERC8183.initialize, (address(this), address(this))))));
        hook = new WarrantSwapJob(core, PC, USDC);
        core.setHookWhitelist(address(hook), true);
        core.setPaymentTokenAllowed(USDC, true);

        vm.prank(client);
        reg.setWarrant(agent, WarrantRegistry.Warrant(100_000, 100, 150, 50, true, true, true, 0));
    }

    function _fair() internal view returns (uint256) {
        (, int256 usd,,,) = IAggregatorV3(USDC_USD).latestRoundData();
        (, int256 eur,,,) = IAggregatorV3(EURC_USD).latestRoundData();
        return (CAPITAL * 1e12 * uint256(usd)) / (uint256(eur) * 1e12);
    }

    /// Open a funded job: the agent ends up holding the client's 0.5 USDC.
    function _fundedJob() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = core.createJob(agent, address(hook), uint48(block.timestamp + 1 days), "swap 0.5 USDC to EURC", address(hook), 0);
        vm.prank(client);
        hook.placeOrder(jobId, USDC, CAPITAL, EURC, client);
        vm.prank(agent);
        core.setBudget(jobId, USDC, FEE, "");
        vm.startPrank(client);
        IERC20(USDC).approve(address(core), FEE);
        IERC20(USDC).approve(address(hook), CAPITAL);
        core.fund(jobId, USDC, FEE, "");
        vm.stopPrank();
    }

    function _disclose(uint256 quotedOut, uint8 verdict, bytes32 q)
        internal
        returns (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t)
    {
        t = WarrantPriceCheck.QuoteTerms(q, address(0), EURC, CAPITAL * 1e12, quotedOut);
        a = WarrantAttestor.PreflightAttestation(client, agent, PC.termsHash(t), 1, verdict, keccak256("scorecard"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, att.digest(a));
        att.submit(a, abi.encodePacked(r, s, v));
    }

    /// The agent "executes" (here: is dealt `out` EURC) and submits it with its disclosure.
    function _deliver(uint256 jobId, uint256 quotedOut, uint256 out, uint8 verdict) internal returns (bytes32 d) {
        (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t) =
            _disclose(quotedOut, verdict, keccak256(abi.encode(jobId)));
        d = att.digest(a);
        deal(EURC, agent, out);
        vm.startPrank(agent);
        IERC20(EURC).approve(address(hook), out);
        core.submit(jobId, d, abi.encode(a, t, out));
        vm.stopPrank();
    }

    function test_fundingHandsTheAgentTheCapital() public {
        uint256 before = IERC20(USDC).balanceOf(agent);
        _fundedJob();
        assertEq(IERC20(USDC).balanceOf(agent) - before, CAPITAL);
        assertEq(IERC20(USDC).balanceOf(address(core)), FEE);
    }

    function test_goodExecutionIsPaid() public {
        uint256 jobId = _fundedJob();
        uint256 q = (_fair() * 9_960) / 10_000;
        _deliver(jobId, q, (q * 9_980) / 10_000, 0); // 0.2% slippage vs quote, ~0.6% under fair
        uint256 agentUsdc = IERC20(USDC).balanceOf(agent);
        assertTrue(hook.settle(jobId));
        assertEq(uint8(core.getJob(jobId).status), uint8(ERC8183.JobStatus.Completed));
        assertEq(IERC20(USDC).balanceOf(agent) - agentUsdc, FEE);
        assertEq(IERC20(EURC).balanceOf(client), (q * 9_980) / 10_000);
    }

    function test_slippageBeyondWarrantIsRejected() public {
        uint256 jobId = _fundedJob();
        uint256 q = (_fair() * 9_990) / 10_000;
        uint256 out = (q * 9_850) / 10_000; // 1.5% worse than disclosed; warrant allows 1%
        _deliver(jobId, q, out, 0);
        uint256 clientUsdc = IERC20(USDC).balanceOf(client);
        WarrantSwapJob.Assessment memory r = hook.preview(jobId);
        assertEq(r.slippageBps, 150);
        assertFalse(r.paid);
        assertFalse(hook.settle(jobId));
        assertEq(uint8(core.getJob(jobId).status), uint8(ERC8183.JobStatus.Rejected));
        assertEq(IERC20(USDC).balanceOf(client) - clientUsdc, FEE); // fee refunded
        assertEq(IERC20(EURC).balanceOf(client), out); // and the client still gets what was produced
    }

    function test_badQuoteDeliveredExactlyIsRejectedByOracle() public {
        uint256 jobId = _fundedJob();
        uint256 q = (_fair() * 9_500) / 10_000; // the quote itself is 5% under Chainlink
        _deliver(jobId, q, q, 0);
        WarrantSwapJob.Assessment memory r = hook.preview(jobId);
        assertEq(r.slippageBps, 0);
        assertGt(r.shortfallBps, r.budgetBps + PC.toleranceBps());
        assertFalse(hook.settle(jobId));
    }

    function test_tradedAgainstOwnFailIsRejected() public {
        uint256 jobId = _fundedJob();
        uint256 q = (_fair() * 9_960) / 10_000;
        _deliver(jobId, q, q, 2); // disclosed FAIL, delivered anyway
        assertTrue(hook.preview(jobId).tradedAgainstFail);
        assertFalse(hook.settle(jobId));
    }

    function test_revokedWarrantIsRejected() public {
        uint256 jobId = _fundedJob();
        uint256 q = (_fair() * 9_960) / 10_000;
        _deliver(jobId, q, q, 0);
        vm.prank(client);
        reg.revoke(agent);
        assertFalse(hook.preview(jobId).warrantOk);
        assertFalse(hook.settle(jobId));
    }

    function test_previewMatchesSettle() public {
        uint256 jobId = _fundedJob();
        uint256 q = (_fair() * 9_960) / 10_000;
        _deliver(jobId, q, (q * 9_950) / 10_000, 0);
        bool expected = hook.preview(jobId).paid;
        assertEq(hook.settle(jobId), expected);
    }

    function test_submitBeforeFundingReverts() public {
        vm.prank(client);
        uint256 jobId = core.createJob(agent, address(hook), uint48(block.timestamp + 1 days), "x", address(hook), 0);
        vm.prank(client);
        hook.placeOrder(jobId, USDC, CAPITAL, EURC, client);
        (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t) =
            _disclose(400_000, 0, keccak256("early"));
        bytes32 d = att.digest(a);
        vm.prank(agent); // budget 0 lets an Open job be submitted in the reference core; the hook refuses
        vm.expectRevert(WarrantSwapJob.NotFunded.selector);
        core.submit(jobId, d, abi.encode(a, t, uint256(0)));
    }

    function test_disclosureForAnotherPrincipalReverts() public {
        uint256 jobId = _fundedJob();
        WarrantPriceCheck.QuoteTerms memory t =
            WarrantPriceCheck.QuoteTerms(keccak256("other"), address(0), EURC, CAPITAL * 1e12, 440_000);
        address other = makeAddr("other-principal");
        vm.prank(other);
        reg.setWarrant(agent, WarrantRegistry.Warrant(100_000, 100, 150, 50, true, true, true, 0));
        WarrantAttestor.PreflightAttestation memory a =
            WarrantAttestor.PreflightAttestation(other, agent, PC.termsHash(t), 1, 0, keccak256("scorecard"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, att.digest(a));
        att.submit(a, abi.encodePacked(r, s, v));
        deal(EURC, agent, 440_000);
        bytes32 d = att.digest(a);
        vm.startPrank(agent);
        IERC20(EURC).approve(address(hook), 440_000);
        vm.expectRevert(WarrantSwapJob.WrongParties.selector);
        core.submit(jobId, d, abi.encode(a, t, uint256(440_000)));
        vm.stopPrank();
    }

    function test_disclosureForAnotherAmountReverts() public {
        uint256 jobId = _fundedJob();
        WarrantPriceCheck.QuoteTerms memory t =
            WarrantPriceCheck.QuoteTerms(keccak256("small"), address(0), EURC, CAPITAL * 1e12 / 10, 44_000); // quoted a tenth
        WarrantAttestor.PreflightAttestation memory a =
            WarrantAttestor.PreflightAttestation(client, agent, PC.termsHash(t), 1, 0, keccak256("scorecard"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, att.digest(a));
        att.submit(a, abi.encodePacked(r, s, v));
        bytes32 d = att.digest(a);
        vm.prank(agent);
        vm.expectRevert(WarrantSwapJob.TermsMismatch.selector);
        core.submit(jobId, d, abi.encode(a, t, uint256(44_000)));
    }

    function test_unattestedDisclosureReverts() public {
        uint256 jobId = _fundedJob();
        WarrantPriceCheck.QuoteTerms memory t =
            WarrantPriceCheck.QuoteTerms(keccak256("unsent"), address(0), EURC, CAPITAL * 1e12, 440_000);
        WarrantAttestor.PreflightAttestation memory a =
            WarrantAttestor.PreflightAttestation(client, agent, PC.termsHash(t), 1, 0, keccak256("scorecard"));
        bytes32 d = att.digest(a);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(WarrantSwapJob.NotAttested.selector, d));
        core.submit(jobId, d, abi.encode(a, t, uint256(440_000)));
    }

    function test_onlyCoreCallsTheHook() public {
        vm.expectRevert(WarrantSwapJob.OnlyCore.selector);
        hook.afterAction(1, ERC8183.complete.selector, "");
    }

    function test_settleBeforeDeliveryReverts() public {
        uint256 jobId = _fundedJob();
        vm.expectRevert(WarrantSwapJob.WrongStatus.selector); // Funded, not Submitted
        hook.settle(jobId);
        vm.expectRevert(WarrantSwapJob.NotDelivered.selector);
        hook.preview(jobId);
    }
}
