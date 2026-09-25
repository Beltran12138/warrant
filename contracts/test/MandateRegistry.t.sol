// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";

contract MandateRegistryTest is Test {
    MandateRegistry reg;
    address principal = makeAddr("principal");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");

    event PreflightAttested(
        address indexed principal,
        address indexed agent,
        bytes32 indexed quoteHash,
        uint32 mandateVersion,
        MandateRegistry.Verdict verdict,
        bytes32 scorecardHash
    );

    function setUp() public {
        reg = new MandateRegistry();
        vm.warp(1_790_000_000);
    }

    function _m(uint64 expiresAt) internal pure returns (MandateRegistry.Mandate memory) {
        return MandateRegistry.Mandate({
            maxUsdPerTradeCents: 100_000, // $1,000 — plugin DEFAULT_MANDATE
            maxSlippageBps: 100,
            maxPriceImpactBps: 150,
            maxFeeBps: 50,
            allowCrossChain: true,
            allowNewApproval: true,
            recipientMustBeSelf: true,
            expiresAt: expiresAt
        });
    }

    function test_setThenRead() public {
        vm.prank(principal);
        uint32 v = reg.setMandate(agent, _m(0));
        (MandateRegistry.Mandate memory m, uint32 version, bool active) = reg.getMandate(principal, agent);
        assertEq(v, 1);
        assertEq(version, 1);
        assertTrue(active);
        assertEq(m.maxUsdPerTradeCents, 100_000);
        assertEq(m.maxSlippageBps, 100);
        assertTrue(m.recipientMustBeSelf);
    }

    function test_unsetIsInactive() public view {
        (, uint32 version, bool active) = reg.getMandate(principal, agent);
        assertEq(version, 0);
        assertFalse(active);
    }

    function test_mandatesAreScopedPerPrincipal() public {
        vm.prank(principal);
        reg.setMandate(agent, _m(0));
        (,, bool strangerView) = reg.getMandate(stranger, agent);
        assertFalse(strangerView, "another principal's mandate must not leak");
    }

    function test_replaceBumpsVersion() public {
        vm.startPrank(principal);
        reg.setMandate(agent, _m(0));
        uint32 v2 = reg.setMandate(agent, _m(0));
        vm.stopPrank();
        assertEq(v2, 2);
    }

    function test_revoke() public {
        vm.startPrank(principal);
        reg.setMandate(agent, _m(0));
        reg.revoke(agent);
        vm.stopPrank();
        (, uint32 version, bool active) = reg.getMandate(principal, agent);
        assertEq(version, 2);
        assertFalse(active);
    }

    function test_revokeTwiceReverts() public {
        vm.startPrank(principal);
        reg.setMandate(agent, _m(0));
        reg.revoke(agent);
        vm.expectRevert(MandateRegistry.NoActiveMandate.selector);
        reg.revoke(agent);
        vm.stopPrank();
    }

    function test_expiry() public {
        vm.prank(principal);
        reg.setMandate(agent, _m(uint64(block.timestamp + 1 days)));
        (,, bool before) = reg.getMandate(principal, agent);
        vm.warp(block.timestamp + 1 days);
        (,, bool at) = reg.getMandate(principal, agent);
        assertTrue(before);
        assertFalse(at, "mandate must be inactive at expiresAt");
    }

    function test_setAlreadyExpiredReverts() public {
        vm.prank(principal);
        vm.expectRevert(MandateRegistry.AlreadyExpired.selector);
        reg.setMandate(agent, _m(uint64(block.timestamp)));
    }

    function test_zeroAgentReverts() public {
        vm.prank(principal);
        vm.expectRevert(MandateRegistry.ZeroAgent.selector);
        reg.setMandate(address(0), _m(0));
    }

    function test_attestEmits() public {
        vm.prank(principal);
        reg.setMandate(agent, _m(0));
        bytes32 q = keccak256("quote-1");
        bytes32 s = keccak256("scorecard-json");
        vm.expectEmit(true, true, true, true, address(reg));
        emit PreflightAttested(principal, agent, q, 1, MandateRegistry.Verdict.Warn, s);
        vm.prank(agent);
        reg.attestPreflight(principal, q, 1, MandateRegistry.Verdict.Warn, s);
    }

    function test_attestByNonAgentReverts() public {
        vm.prank(principal);
        reg.setMandate(agent, _m(0));
        vm.prank(stranger);
        vm.expectRevert(MandateRegistry.NoActiveMandate.selector);
        reg.attestPreflight(principal, bytes32(0), 1, MandateRegistry.Verdict.Pass, bytes32(0));
    }

    function test_attestStaleVersionReverts() public {
        vm.startPrank(principal);
        reg.setMandate(agent, _m(0));
        reg.setMandate(agent, _m(0)); // v2
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.StaleMandateVersion.selector, uint32(2), uint32(1)));
        reg.attestPreflight(principal, bytes32(0), 1, MandateRegistry.Verdict.Pass, bytes32(0));
    }

    function test_attestAfterRevokeReverts() public {
        vm.startPrank(principal);
        reg.setMandate(agent, _m(0));
        reg.revoke(agent);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(MandateRegistry.NoActiveMandate.selector);
        reg.attestPreflight(principal, bytes32(0), 2, MandateRegistry.Verdict.Pass, bytes32(0));
    }
}
