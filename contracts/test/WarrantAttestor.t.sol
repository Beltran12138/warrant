// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WarrantRegistry} from "../src/WarrantRegistry.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";

contract WarrantAttestorTest is Test {
    WarrantRegistry reg;
    WarrantAttestor att;
    address principal = makeAddr("principal");
    address relayer = makeAddr("relayer");
    uint256 agentPk = 0xA11CE;
    address agent;
    uint256 strangerPk = 0xB0B;

    bytes32 constant QUOTE = keccak256("quote-1");
    bytes32 constant SCORECARD = keccak256("scorecard");
    uint256 constant N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    event SignedPreflightAttested(
        address indexed principal,
        address indexed agent,
        bytes32 indexed quoteHash,
        uint32 warrantVersion,
        uint8 verdict,
        bytes32 scorecardHash,
        address submitter
    );

    function setUp() public {
        vm.warp(1_790_000_000);
        agent = vm.addr(agentPk);
        reg = new WarrantRegistry();
        att = new WarrantAttestor(reg);
        vm.prank(principal);
        reg.setWarrant(agent, _m(0));
    }

    function _m(uint64 expiresAt) internal pure returns (WarrantRegistry.Warrant memory) {
        return WarrantRegistry.Warrant(100_000, 100, 150, 50, true, true, true, expiresAt);
    }

    function _a(uint32 version, uint8 verdict) internal view returns (WarrantAttestor.PreflightAttestation memory) {
        return WarrantAttestor.PreflightAttestation(principal, agent, QUOTE, version, verdict, SCORECARD);
    }

    function _sign(uint256 pk, WarrantAttestor target, WarrantAttestor.PreflightAttestation memory a)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, target.digest(a));
        return abi.encodePacked(r, s, v);
    }

    /// Digest anchored to Foundry's own EIP-712 implementation, not to the contract's abi.encode.
    function test_digestMatchesIndependentEip712() public view {
        WarrantAttestor.PreflightAttestation memory a = _a(1, 2);
        string memory json = string.concat(
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"PreflightAttestation":[{"name":"principal","type":"address"},{"name":"agent","type":"address"},',
            '{"name":"quoteHash","type":"bytes32"},{"name":"warrantVersion","type":"uint32"},',
            '{"name":"verdict","type":"uint8"},{"name":"scorecardHash","type":"bytes32"}]},',
            '"primaryType":"PreflightAttestation",',
            string.concat(
                '"domain":{"name":"Warrant","version":"1","chainId":',
                vm.toString(block.chainid),
                ',"verifyingContract":"',
                vm.toString(address(att)),
                '"},'
            ),
            string.concat(
                '"message":{"principal":"',
                vm.toString(principal),
                '","agent":"',
                vm.toString(agent),
                '","quoteHash":"',
                vm.toString(QUOTE),
                '","warrantVersion":1,"verdict":2,"scorecardHash":"',
                vm.toString(SCORECARD),
                '"}}'
            )
        );
        assertEq(att.digest(a), vm.eip712HashTypedData(json));
    }

    function test_relayerSubmitsAgentSignature() public {
        WarrantAttestor.PreflightAttestation memory a = _a(1, 0);
        bytes memory sig = _sign(agentPk, att, a);
        vm.expectEmit(true, true, true, true, address(att));
        emit SignedPreflightAttested(principal, agent, QUOTE, 1, 0, SCORECARD, relayer);
        vm.prank(relayer);
        att.submit(a, sig);
        assertTrue(att.submitted(att.digest(a)));
    }

    function test_replayReverts() public {
        WarrantAttestor.PreflightAttestation memory a = _a(1, 0);
        bytes memory sig = _sign(agentPk, att, a);
        att.submit(a, sig);
        vm.expectRevert(abi.encodeWithSelector(WarrantAttestor.AlreadySubmitted.selector, att.digest(a)));
        att.submit(a, sig);
    }

    function test_signedByStrangerReverts() public {
        WarrantAttestor.PreflightAttestation memory a = _a(1, 0);
        bytes memory sig = _sign(strangerPk, att, a);
        vm.expectRevert(abi.encodeWithSelector(WarrantAttestor.NotSignedByAgent.selector, vm.addr(strangerPk), agent));
        att.submit(a, sig);
    }

    /// A PASS signature cannot be replayed as a FAIL (or any other field change).
    function test_tamperedVerdictReverts() public {
        bytes memory sig = _sign(agentPk, att, _a(1, 0));
        vm.expectPartialRevert(WarrantAttestor.NotSignedByAgent.selector);
        att.submit(_a(1, 2), sig);
    }

    /// Signature made for another deployment (other chain or address) does not verify here.
    function test_otherDomainReverts() public {
        WarrantAttestor other = new WarrantAttestor(reg);
        WarrantAttestor.PreflightAttestation memory a = _a(1, 0);
        bytes memory sig = _sign(agentPk, other, a);
        vm.expectPartialRevert(WarrantAttestor.NotSignedByAgent.selector);
        att.submit(a, sig);
    }

    function test_staleVersionReverts() public {
        WarrantAttestor.PreflightAttestation memory a = _a(1, 0);
        bytes memory sig = _sign(agentPk, att, a);
        vm.prank(principal);
        reg.setWarrant(agent, _m(0)); // v2
        vm.expectRevert(abi.encodeWithSelector(WarrantRegistry.StaleWarrantVersion.selector, uint32(2), uint32(1)));
        att.submit(a, sig);
    }

    function test_revokedReverts() public {
        vm.prank(principal);
        reg.revoke(agent); // v2, inactive
        WarrantAttestor.PreflightAttestation memory a = _a(2, 0);
        bytes memory sig = _sign(agentPk, att, a);
        vm.expectRevert(WarrantRegistry.NoActiveWarrant.selector);
        att.submit(a, sig);
    }

    function test_expiredReverts() public {
        vm.prank(principal);
        reg.setWarrant(agent, _m(uint64(block.timestamp + 1 days))); // v2
        WarrantAttestor.PreflightAttestation memory a = _a(2, 0);
        bytes memory sig = _sign(agentPk, att, a);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(WarrantRegistry.NoActiveWarrant.selector);
        att.submit(a, sig);
    }

    function test_noWarrantReverts() public {
        WarrantAttestor.PreflightAttestation memory a =
            WarrantAttestor.PreflightAttestation(makeAddr("nobody"), agent, QUOTE, 0, 0, SCORECARD);
        bytes memory sig = _sign(agentPk, att, a);
        vm.expectRevert(WarrantRegistry.NoActiveWarrant.selector);
        att.submit(a, sig);
    }

    /// (r, n - s, v ^ 1) recovers the same signer; it must be rejected, not treated as a new digest.
    function test_malleableSignatureReverts() public {
        WarrantAttestor.PreflightAttestation memory a = _a(1, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, att.digest(a));
        bytes memory twin = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(WarrantAttestor.BadSignature.selector);
        att.submit(a, twin);
    }

    function test_badLengthReverts() public {
        vm.expectRevert(WarrantAttestor.BadSignature.selector);
        att.submit(_a(1, 0), hex"1234");
    }

    function test_invalidVerdictReverts() public {
        WarrantAttestor.PreflightAttestation memory a = _a(1, 3);
        bytes memory sig = _sign(agentPk, att, a);
        vm.expectRevert(abi.encodeWithSelector(WarrantAttestor.InvalidVerdict.selector, uint8(3)));
        att.submit(a, sig);
    }

    /// Legacy v in {0,1} is accepted and normalised.
    function test_vZeroOneAccepted() public {
        WarrantAttestor.PreflightAttestation memory a = _a(1, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, att.digest(a));
        att.submit(a, abi.encodePacked(r, s, v - 27));
        assertTrue(att.submitted(att.digest(a)));
    }
}
