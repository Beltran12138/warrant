// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WarrantRegistry} from "../src/WarrantRegistry.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";
import {IERC8004Identity, IERC8004Reputation} from "../src/WarrantReputation.sol";
import {WarrantPriceCheck, IAggregatorV3} from "../src/WarrantPriceCheck.sol";

contract MockFeed is IAggregatorV3 {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public immutable dec;

    constructor(uint8 d) {
        dec = d;
    }

    function set(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
    }

    function decimals() external view returns (uint8) {
        return dec;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract MockIdentity is IERC8004Identity {
    mapping(uint256 => address) public wallet;

    function setWallet(uint256 id, address w) external {
        wallet[id] = w;
    }

    function getMetadata(uint256 id, string memory) external view returns (bytes memory) {
        return wallet[id] == address(0) ? bytes("") : abi.encodePacked(wallet[id]);
    }
}

contract MockReputation is IERC8004Reputation {
    int128 public lastValue;
    string public lastTag1;
    string public lastTag2;
    bytes32 public lastHash;
    uint256 public calls;

    function giveFeedback(uint256, int128 value, uint8, string calldata t1, string calldata t2, string calldata, string calldata, bytes32 h)
        external
    {
        lastValue = value;
        lastTag1 = t1;
        lastTag2 = t2;
        lastHash = h;
        calls++;
    }
}

contract WarrantPriceCheckTest is Test {
    WarrantRegistry reg;
    WarrantAttestor att;
    WarrantPriceCheck pc;
    MockFeed usdFeed;
    MockFeed eurFeed;
    MockIdentity idr;
    MockReputation rep;

    address principal = makeAddr("principal");
    uint256 agentPk = 0xA11CE;
    address agent;
    address constant NATIVE_USDC = address(0); // 18 decimals, as on Arc
    address constant EURC = address(0xE0C); // 6 decimals
    uint256 constant T0 = 1_790_000_000;

    function setUp() public {
        vm.warp(T0);
        agent = vm.addr(agentPk);
        reg = new WarrantRegistry();
        att = new WarrantAttestor(reg);
        usdFeed = new MockFeed(8);
        eurFeed = new MockFeed(8);
        usdFeed.set(1_00000000, T0); // USDC = $1.00000000
        eurFeed.set(1_25000000, T0); // EURC = $1.25000000
        idr = new MockIdentity();
        rep = new MockReputation();

        address[] memory tokens = new address[](2);
        tokens[0] = NATIVE_USDC;
        tokens[1] = EURC;
        IAggregatorV3[] memory aggs = new IAggregatorV3[](2);
        aggs[0] = usdFeed;
        aggs[1] = eurFeed;
        uint8[] memory dec = new uint8[](2);
        dec[0] = 18;
        dec[1] = 6;
        uint32[] memory ages = new uint32[](2);
        ages[0] = 1 days;
        ages[1] = 1 days;
        pc = new WarrantPriceCheck(att, idr, rep, 100, tokens, aggs, dec, ages);

        // $1,000 per trade, 1% slippage, 1.5% price impact, 0.5% fees: cost budget 200 bps, +100 tolerance.
        vm.prank(principal);
        reg.setWarrant(agent, WarrantRegistry.Warrant(100_000, 100, 150, 50, true, true, true, 0));
    }

    /// 0.5 USDC -> EURC at $1.00 / $1.25: fair output is 0.4 EURC = 400_000 base units (computed by hand).
    function _terms(uint256 buyAmount) internal pure returns (WarrantPriceCheck.QuoteTerms memory) {
        return WarrantPriceCheck.QuoteTerms(keccak256("quote-1"), NATIVE_USDC, EURC, 0.5 ether, buyAmount);
    }

    function _attest(WarrantPriceCheck.QuoteTerms memory t, uint8 verdict)
        internal
        returns (WarrantAttestor.PreflightAttestation memory a)
    {
        a = WarrantAttestor.PreflightAttestation(principal, agent, pc.termsHash(t), 1, verdict, keccak256("scorecard"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, att.digest(a));
        att.submit(a, abi.encodePacked(r, s, v));
    }

    function test_fairOutMatchesHandComputation() public view {
        assertEq(pc.fairOut(NATIVE_USDC, EURC, 0.5 ether), 400_000);
        assertEq(pc.fairOut(EURC, NATIVE_USDC, 400_000), 0.5 ether);
    }

    /// Terms hash anchored to an independent encoding, not to the contract's own function.
    function test_termsHashIndependent() public view {
        WarrantPriceCheck.QuoteTerms memory t = _terms(396_000);
        bytes32 expected = keccak256(
            bytes.concat(
                keccak256("quote-1"), bytes32(uint256(0)), bytes32(uint256(uint160(EURC))), bytes32(uint256(0.5 ether)), bytes32(uint256(396_000))
            )
        );
        assertEq(pc.termsHash(t), expected);
    }

    function test_withinBudgetIsConsistent() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(396_000); // 1% short of fair
        WarrantAttestor.PreflightAttestation memory a = _attest(t, 0);
        vm.expectEmit(true, true, true, true);
        emit WarrantPriceCheck.PriceChecked(att.digest(a), agent, principal, 400_000, 396_000, 100, 200, false, false);
        (, bool contradicted) = pc.check(a, t);
        assertFalse(contradicted);
    }

    function test_boundaryIsNotOutOfBounds() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(388_000); // exactly 300 bps = budget + tolerance
        (, bool contradicted) = pc.check(_attest(t, 0), t);
        assertFalse(contradicted);
    }

    function test_passOverBudgetIsContradicted() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(380_000); // 5% short of fair
        WarrantAttestor.PreflightAttestation memory a = _attest(t, 0);
        vm.expectEmit(true, true, true, true);
        emit WarrantPriceCheck.PriceChecked(att.digest(a), agent, principal, 400_000, 380_000, 500, 200, true, true);
        (, bool contradicted) = pc.check(a, t);
        assertTrue(contradicted);
    }

    function test_failOverBudgetIsNotContradicted() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(380_000);
        (, bool contradicted) = pc.check(_attest(t, 2), t);
        assertFalse(contradicted);
    }

    function test_warnOverBudgetIsNotContradicted() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(380_000);
        (, bool contradicted) = pc.check(_attest(t, 1), t);
        assertFalse(contradicted);
    }

    function test_quoteBetterThanOracleHasZeroShortfall() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(410_000);
        WarrantAttestor.PreflightAttestation memory a = _attest(t, 0);
        vm.expectEmit(true, true, true, true);
        emit WarrantPriceCheck.PriceChecked(att.digest(a), agent, principal, 400_000, 410_000, 0, 200, false, false);
        pc.check(a, t);
    }

    function test_swappedAmountsRevert() public {
        WarrantAttestor.PreflightAttestation memory a = _attest(_terms(380_000), 0);
        WarrantPriceCheck.QuoteTerms memory forged = _terms(399_000); // relayer tries to make the quote look fine
        vm.expectRevert(abi.encodeWithSelector(WarrantPriceCheck.TermsMismatch.selector, a.quoteHash, pc.termsHash(forged)));
        pc.check(a, forged);
    }

    function test_unattestedReverts() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(396_000);
        WarrantAttestor.PreflightAttestation memory a =
            WarrantAttestor.PreflightAttestation(principal, agent, pc.termsHash(t), 1, 0, keccak256("scorecard"));
        vm.expectRevert(abi.encodeWithSelector(WarrantPriceCheck.NotAttested.selector, att.digest(a)));
        pc.check(a, t);
    }

    function test_checkTwiceReverts() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(396_000);
        WarrantAttestor.PreflightAttestation memory a = _attest(t, 0);
        pc.check(a, t);
        vm.expectRevert(abi.encodeWithSelector(WarrantPriceCheck.AlreadyChecked.selector, att.digest(a)));
        pc.check(a, t);
    }

    function test_staleFeedReverts() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(396_000);
        WarrantAttestor.PreflightAttestation memory a = _attest(t, 0);
        vm.warp(T0 + 1 days + 1);
        vm.expectRevert(abi.encodeWithSelector(WarrantPriceCheck.StaleFeed.selector, NATIVE_USDC, T0));
        pc.check(a, t);
    }

    function test_nonPositivePriceReverts() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(396_000);
        WarrantAttestor.PreflightAttestation memory a = _attest(t, 0);
        eurFeed.set(0, T0);
        vm.expectRevert(abi.encodeWithSelector(WarrantPriceCheck.BadPrice.selector, EURC, int256(0)));
        pc.check(a, t);
    }

    function test_unknownTokenReverts() public {
        WarrantPriceCheck.QuoteTerms memory t =
            WarrantPriceCheck.QuoteTerms(keccak256("q"), NATIVE_USDC, address(0xBAD), 1 ether, 1);
        WarrantAttestor.PreflightAttestation memory a = _attest(t, 0);
        vm.expectRevert(abi.encodeWithSelector(WarrantPriceCheck.NoFeed.selector, address(0xBAD)));
        pc.check(a, t);
    }

    function test_changedWarrantReverts() public {
        WarrantPriceCheck.QuoteTerms memory t = _terms(396_000);
        WarrantAttestor.PreflightAttestation memory a = _attest(t, 0);
        vm.prank(principal);
        reg.setWarrant(agent, WarrantRegistry.Warrant(100_000, 100, 10, 10, true, true, true, 0)); // v2, tighter
        vm.expectRevert(abi.encodeWithSelector(WarrantRegistry.StaleWarrantVersion.selector, uint32(2), uint32(1)));
        pc.check(a, t);
    }

    function test_rateContradictedIsNegativeFeedback() public {
        idr.setWallet(7, agent);
        WarrantPriceCheck.QuoteTerms memory t = _terms(380_000);
        WarrantAttestor.PreflightAttestation memory a = _attest(t, 0);
        pc.checkAndRate(a, t, 7);
        assertEq(rep.calls(), 1);
        assertEq(rep.lastValue(), -1);
        assertEq(rep.lastTag1(), "warrant-oracle");
        assertEq(rep.lastTag2(), "contradicted");
        assertEq(rep.lastHash(), att.digest(a));
    }

    function test_rateConsistentIsPositiveFeedback() public {
        idr.setWallet(7, agent);
        WarrantPriceCheck.QuoteTerms memory t = _terms(396_000);
        pc.checkAndRate(_attest(t, 0), t, 7);
        assertEq(rep.lastValue(), 1);
        assertEq(rep.lastTag2(), "consistent");
    }

    function test_rateWrongIdentityReverts() public {
        idr.setWallet(7, makeAddr("someone-else"));
        WarrantPriceCheck.QuoteTerms memory t = _terms(396_000);
        WarrantAttestor.PreflightAttestation memory a = _attest(t, 0);
        vm.expectRevert(
            abi.encodeWithSelector(WarrantPriceCheck.NotAgentWallet.selector, 7, makeAddr("someone-else"), agent)
        );
        pc.checkAndRate(a, t, 7);
    }

    /// Feeds with different decimals (8 vs 18): EURC at $1.25 reported as 1.25e18; still 0.4 EURC (by hand).
    function test_mixedFeedDecimals() public {
        MockFeed eur18 = new MockFeed(18);
        eur18.set(1.25e18, T0);
        address[] memory tokens = new address[](2);
        tokens[0] = NATIVE_USDC;
        tokens[1] = EURC;
        IAggregatorV3[] memory aggs = new IAggregatorV3[](2);
        aggs[0] = usdFeed;
        aggs[1] = eur18;
        uint8[] memory dec = new uint8[](2);
        dec[0] = 18;
        dec[1] = 6;
        uint32[] memory ages = new uint32[](2);
        ages[0] = 1 days;
        ages[1] = 1 days;
        WarrantPriceCheck pc2 = new WarrantPriceCheck(att, idr, rep, 100, tokens, aggs, dec, ages);
        assertEq(pc2.fairOut(NATIVE_USDC, EURC, 0.5 ether), 400_000);
        assertEq(pc2.fairOut(EURC, NATIVE_USDC, 400_000), 0.5 ether);
    }

    function test_constructorLengthMismatchReverts() public {
        address[] memory tokens = new address[](1);
        IAggregatorV3[] memory aggs = new IAggregatorV3[](0);
        vm.expectRevert(WarrantPriceCheck.LengthMismatch.selector);
        new WarrantPriceCheck(att, idr, rep, 100, tokens, aggs, new uint8[](1), new uint32[](1));
    }
}
