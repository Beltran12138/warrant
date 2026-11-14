// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {WarrantRegistry} from "warrant/WarrantRegistry.sol";
import {WarrantAttestor} from "warrant/WarrantAttestor.sol";
import {WarrantGuardian} from "../src/WarrantGuardian.sol";
import {WarrantSentinel} from "../src/WarrantSentinel.sol";
import {DemoUSD} from "../src/DemoUSD.sol";

/// Stand-in for the Reactive system contract at 0x8888…8888: records subscriptions and callback
/// requests so the test harness can play the network.
contract MockSystem {
    struct Sub {
        uint256 chainId;
        address contract_;
        uint256[4] topics;
    }

    struct Request {
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    Sub[] internal _subs;
    Request[] internal _requests;

    receive() external payable {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function subscribe(uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        _subs.push(Sub(c, a, [t0, t1, t2, t3]));
    }

    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external pure {
        revert("unused");
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory c) external {
        _requests.push(Request(c.chainId, c.recipient, c.gasLimit, c.payload));
    }

    function subCount() external view returns (uint256) {
        return _subs.length;
    }

    function sub(uint256 i) external view returns (Sub memory) {
        return _subs[i];
    }

    function requestCount() external view returns (uint256) {
        return _requests.length;
    }

    function request(uint256 i) external view returns (Request memory) {
        return _requests[i];
    }
}

/// Stand-in for the destination-chain callback proxy: overwrites the payload's first argument with
/// the requesting reactive contract, then calls the recipient (as the real proxy does).
contract MockCallbackProxy {
    receive() external payable {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function deliver(address rvm, address recipient, bytes memory payload) external returns (bool ok) {
        assembly {
            // payload layout: [len][4-byte selector][32-byte first arg]...
            mstore(add(payload, 36), rvm)
        }
        (ok,) = recipient.call(payload);
    }
}

contract LoopTest is Test {
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    address internal constant SYSTEM = 0x8888888888888888888888888888888888888888;

    MockSystem internal sys;
    MockCallbackProxy internal proxy;
    WarrantRegistry internal registry;
    WarrantAttestor internal attestor;
    DemoUSD internal usd;
    WarrantSentinel internal sentinel;
    WarrantGuardian internal guardian;

    address internal principal = makeAddr("principal");
    uint256 internal agentKey = 0xA11CE;
    address internal agent;
    address internal dex = makeAddr("dex");

    uint256 internal delivered; // index of the next callback request to deliver

    function setUp() public {
        agent = vm.addr(agentKey);
        vm.etch(SYSTEM, address(new MockSystem()).code);
        sys = MockSystem(payable(SYSTEM));
        proxy = new MockCallbackProxy();

        registry = new WarrantRegistry();
        attestor = new WarrantAttestor(registry);
        usd = new DemoUSD();

        sentinel = new WarrantSentinel(block.chainid, address(registry), address(attestor), address(usd));
        guardian = new WarrantGuardian(
            IPayable(payable(address(proxy))), address(sentinel), registry, IERC20(address(usd)), principal
        );
        sentinel.setGuardian(address(guardian));

        usd.mint(address(guardian), 1_000e6);
        vm.recordLogs();
        vm.startPrank(principal);
        guardian.setWarrant(agent, _warrant());
        guardian.setBudget(agent, 100e6);
        vm.stopPrank();
        _relay();
    }

    // ------------------------------------------------------------------ harness

    function _warrant() internal pure returns (WarrantRegistry.Warrant memory) {
        return WarrantRegistry.Warrant({
            maxUsdPerTradeCents: 50_00,
            maxSlippageBps: 100,
            maxPriceImpactBps: 100,
            maxFeeBps: 300,
            allowCrossChain: false,
            allowNewApproval: false,
            recipientMustBeSelf: true,
            expiresAt: 0
        });
    }

    function _matches(MockSystem.Sub memory s, Vm.Log memory l) internal view returns (bool) {
        if (s.chainId != 0 && s.chainId != block.chainid) return false;
        if (s.contract_ != address(0) && s.contract_ != l.emitter) return false;
        for (uint256 i = 0; i < 4; i++) {
            if (s.topics[i] == REACTIVE_IGNORE) continue;
            uint256 have = i < l.topics.length ? uint256(l.topics[i]) : 0;
            if (s.topics[i] != have) return false;
        }
        return true;
    }

    /// Play Reactive Network: every recorded origin log that matches a subscription is handed to
    /// react() as SYSTEM (once, however many subscriptions match); then every callback the sentinel
    /// requested is delivered through the proxy. Repeats until quiet, since react() can subscribe.
    function _relay() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter == SYSTEM || l.emitter == address(sentinel)) continue;
            uint256 n = sys.subCount();
            bool hit;
            for (uint256 j = 0; j < n && !hit; j++) {
                hit = _matches(sys.sub(j), l);
            }
            if (!hit) continue;
            IReactive.LogRecord memory r;
            r.chainId = block.chainid;
            r.contractAddress = l.emitter;
            if (l.topics.length > 0) r.topic0 = uint256(l.topics[0]);
            if (l.topics.length > 1) r.topic1 = uint256(l.topics[1]);
            if (l.topics.length > 2) r.topic2 = uint256(l.topics[2]);
            if (l.topics.length > 3) r.topic3 = uint256(l.topics[3]);
            r.data = l.data;
            r.opCode = l.topics.length;
            r.txHash = uint256(keccak256(abi.encode(i, l.emitter, l.data)));
            vm.prank(SYSTEM);
            sentinel.react(r);
        }
        uint256 m = sys.requestCount();
        for (; delivered < m; delivered++) {
            MockSystem.Request memory q = sys.request(delivered);
            assertEq(q.chainId, block.chainid, "callback chain");
            assertTrue(proxy.deliver(address(sentinel), q.recipient, q.payload), "callback reverted");
        }
        vm.getRecordedLogs(); // drop logs emitted while reacting / delivering
    }

    function _attest(uint8 verdict, bytes32 quoteHash) internal {
        (, uint32 version,) = registry.getWarrant(address(guardian), agent);
        vm.prank(agent);
        registry.attestPreflight(
            address(guardian), quoteHash, version, WarrantRegistry.Verdict(verdict), keccak256("scorecard")
        );
    }

    function _attestSigned(uint8 verdict, bytes32 quoteHash) internal {
        (, uint32 version,) = registry.getWarrant(address(guardian), agent);
        WarrantAttestor.PreflightAttestation memory a = WarrantAttestor.PreflightAttestation({
            principal: address(guardian),
            agent: agent,
            quoteHash: quoteHash,
            warrantVersion: version,
            verdict: verdict,
            scorecardHash: keccak256("scorecard")
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, attestor.digest(a));
        vm.prank(makeAddr("relayer"));
        attestor.submit(a, abi.encodePacked(r, s, v));
    }

    function _trade(uint256 amount) internal {
        vm.prank(agent);
        usd.transfer(dex, amount);
    }

    function _draw(uint256 amount) internal {
        vm.prank(agent);
        guardian.draw(amount);
    }

    function _active() internal view returns (bool a) {
        (,, a) = registry.getWarrant(address(guardian), agent);
    }

    // ------------------------------------------------------------------ wiring

    function test_topicConstantsMatchCompiledEvents() public pure {
        assertEq(
            keccak256("WarrantSet(address,address,uint32,(uint64,uint16,uint16,uint16,bool,bool,bool,uint64))"),
            WarrantRegistry.WarrantSet.selector
        );
        assertEq(
            keccak256("PreflightAttested(address,address,bytes32,uint32,uint8,bytes32)"),
            WarrantRegistry.PreflightAttested.selector
        );
        assertEq(
            keccak256("SignedPreflightAttested(address,address,bytes32,uint32,uint8,bytes32,address)"),
            WarrantAttestor.SignedPreflightAttested.selector
        );
        assertEq(keccak256("Unfrozen(address)"), WarrantGuardian.Unfrozen.selector);
        assertEq(keccak256("Transfer(address,address,uint256)"), IERC20.Transfer.selector);
    }

    function test_subscriptionsAreKeyedOnGuardianAndAgent() public view {
        // 4 from setGuardian + 1 for the agent's outflows, added when WarrantSet was relayed
        assertEq(sys.subCount(), 5);
        MockSystem.Sub memory t = sys.sub(4);
        assertEq(t.contract_, address(usd));
        assertEq(t.topics[0], uint256(IERC20.Transfer.selector));
        assertEq(t.topics[1], uint256(uint160(agent)));
        assertEq(t.topics[2], REACTIVE_IGNORE);
        assertTrue(sentinel.watched(agent));
    }

    function test_rewatchingIsIdempotent() public {
        vm.recordLogs();
        vm.prank(principal);
        guardian.setWarrant(agent, _warrant()); // second WarrantSet for the same agent
        _relay();
        assertEq(sys.subCount(), 5);
    }

    // ------------------------------------------------------------------ the loop

    function test_disclosedTradeIsCovered() public {
        vm.recordLogs();
        _attest(0, keccak256("q1"));
        _draw(20e6);
        _trade(20e6);
        _relay();
        assertEq(sys.requestCount(), 0);
        assertFalse(guardian.frozen(agent));
        assertTrue(_active());
        assertEq(sentinel.unusedDisclosures(agent), 0);
        assertEq(guardian.budget(agent), 80e6);
    }

    function test_signedDisclosureCountsToo() public {
        vm.recordLogs();
        _attestSigned(1, keccak256("q1")); // WARN still covers: it was disclosed
        _draw(20e6);
        _trade(20e6);
        _relay();
        assertEq(sys.requestCount(), 0);
        assertFalse(guardian.frozen(agent));
    }

    function test_undisclosedTradeFreezesAgent() public {
        vm.recordLogs();
        _draw(30e6);
        _trade(30e6);
        _relay();

        assertEq(sys.requestCount(), 1);
        assertTrue(guardian.frozen(agent));
        assertEq(guardian.budget(agent), 0);
        assertFalse(_active(), "warrant revoked");

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(WarrantGuardian.AgentFrozen.selector, agent));
        guardian.draw(1);
    }

    function test_tradeAfterFailFreezesWithThatReason() public {
        vm.recordLogs();
        _draw(30e6);
        _attest(2, keccak256("bad quote"));
        _trade(30e6);
        _relay();

        assertEq(sys.requestCount(), 1);
        MockSystem.Request memory q = sys.request(0);
        bytes memory args = new bytes(q.payload.length - 4);
        for (uint256 i = 0; i < args.length; i++) {
            args[i] = q.payload[i + 4];
        }
        (, address who, uint8 reason,,) = abi.decode(args, (address, address, uint8, uint256, uint256));
        assertEq(who, agent);
        assertEq(reason, uint8(WarrantGuardian.Reason.TradedAfterFail));
        assertTrue(guardian.frozen(agent));
    }

    function test_oneDisclosureCoversOneTrade() public {
        vm.recordLogs();
        _attest(0, keccak256("q1"));
        _draw(40e6);
        _trade(20e6);
        _trade(20e6); // second outflow has nothing in front of it
        _relay();
        assertEq(sys.requestCount(), 1);
        assertTrue(guardian.frozen(agent));
    }

    function test_refundToGuardianIsNotATrade() public {
        vm.recordLogs();
        _draw(10e6);
        vm.prank(agent);
        usd.transfer(address(guardian), 10e6);
        _relay();
        assertEq(sys.requestCount(), 0);
        assertFalse(guardian.frozen(agent));
    }

    function test_secondViolationBeforeFreezeLandsRequestsOnce() public {
        vm.recordLogs();
        _draw(40e6);
        _trade(20e6);
        _trade(20e6);
        _relay();
        assertEq(sys.requestCount(), 1);
    }

    function test_unfreezeResetsAndRegrantRestoresTrading() public {
        vm.recordLogs();
        _attest(0, keccak256("q0")); // left unused when the violation happens
        _draw(20e6);
        _trade(10e6); // covered by q0
        _trade(10e6); // violation
        _relay();
        assertTrue(guardian.frozen(agent));

        vm.recordLogs();
        vm.startPrank(principal);
        guardian.unfreeze(agent);
        guardian.setWarrant(agent, _warrant());
        guardian.setBudget(agent, 50e6);
        vm.stopPrank();
        _relay();
        assertFalse(sentinel.freezeRequested(agent));
        assertEq(sentinel.unusedDisclosures(agent), 0);

        vm.recordLogs();
        _attest(0, keccak256("q2"));
        _draw(10e6);
        _trade(10e6);
        _relay();
        assertEq(sys.requestCount(), 1, "no new freeze");
        assertFalse(guardian.frozen(agent));
    }

    function test_otherAgentsAndOtherChainsAreIgnored() public {
        address stranger = makeAddr("stranger");
        usd.mint(stranger, 5e6);
        vm.recordLogs();
        vm.prank(stranger);
        usd.transfer(dex, 5e6);
        _relay();
        assertEq(sys.requestCount(), 0);

        IReactive.LogRecord memory r;
        r.chainId = block.chainid + 1;
        r.contractAddress = address(usd);
        r.topic0 = uint256(IERC20.Transfer.selector);
        r.topic1 = uint256(uint160(agent));
        r.topic2 = uint256(uint160(dex));
        r.data = abi.encode(uint256(1));
        r.opCode = 3;
        vm.prank(SYSTEM);
        sentinel.react(r);
        assertEq(sys.requestCount(), 0);
    }

    // ------------------------------------------------------------------ access control

    function test_reactOnlyFromSystem() public {
        IReactive.LogRecord memory r;
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), SYSTEM));
        sentinel.react(r);
    }

    function test_freezeOnlyThroughProxyFromSentinel() public {
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), address(proxy)));
        guardian.freeze(address(sentinel), agent, WarrantGuardian.Reason.Undisclosed, block.chainid, 0);

        bytes memory payload = abi.encodeWithSignature(
            "freeze(address,address,uint8,uint256,uint256)", address(0), agent, uint8(0), block.chainid, uint256(0)
        );
        assertFalse(proxy.deliver(makeAddr("other reactive"), address(guardian), payload));
        assertFalse(guardian.frozen(agent));
    }

    function test_freezeTwiceIsHarmless() public {
        bytes memory payload = abi.encodeWithSignature(
            "freeze(address,address,uint8,uint256,uint256)", address(0), agent, uint8(0), block.chainid, uint256(7)
        );
        assertTrue(proxy.deliver(address(sentinel), address(guardian), payload));
        assertTrue(proxy.deliver(address(sentinel), address(guardian), payload));
        assertTrue(guardian.frozen(agent));
    }

    function test_drawNeedsActiveWarrantAndBudget() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(WarrantGuardian.OverBudget.selector, 101e6, 100e6));
        guardian.draw(101e6);

        address other = makeAddr("no warrant");
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(WarrantGuardian.NoActiveWarrant.selector, other));
        guardian.draw(1);
    }

    function test_ownerOnly() public {
        vm.expectRevert(WarrantGuardian.NotOwner.selector);
        guardian.setBudget(agent, 1);
        vm.prank(principal);
        vm.expectRevert(WarrantSentinel.NotOwner.selector);
        sentinel.watch(agent);
        vm.expectRevert(WarrantSentinel.GuardianAlreadySet.selector);
        sentinel.setGuardian(address(1));
    }
}
