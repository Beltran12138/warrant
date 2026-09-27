// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WarrantRegistry} from "../src/WarrantRegistry.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";
import {WarrantReputation, IERC8004Identity, IERC8004Reputation} from "../src/WarrantReputation.sol";

interface IIdentityFull {
    function register(string memory agentURI) external returns (uint256 agentId);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
}

interface IReputationRead {
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);
}

/// Runs against the live ERC-8004 v2.0.0 registries and the deployed WarrantRegistry on an Avalanche Fuji
/// fork (same addresses and v2.0.0 on Monad testnet; Foundry 1.8 refuses to fork Monad from an
/// Ethereum-instantiated EVM), so identity and reputation behaviour is the real implementation, not a mock.
/// forge test --match-contract WarrantReputationForkTest   (needs network access to the Fuji RPC)
contract WarrantReputationForkTest is Test {
    address constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    WarrantRegistry constant REGISTRY = WarrantRegistry(0x37cdFe2a144993dC3145367305fF66E29302E673);

    WarrantAttestor att;
    WarrantReputation bridge;
    address operator = makeAddr("agent-operator");
    address principal = makeAddr("principal");
    address relayer = makeAddr("relayer");
    uint256 agentPk = 0xA11CE;
    address agent;
    uint256 agentId;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("fuji"));
        agent = vm.addr(agentPk);
        att = new WarrantAttestor(REGISTRY);
        bridge = new WarrantReputation(att, IERC8004Identity(IDENTITY), IERC8004Reputation(REPUTATION));

        vm.prank(operator);
        agentId = IIdentityFull(IDENTITY).register("data:application/json;base64,e30=");
        _bindWallet(agentId, agent, agentPk);

        vm.prank(principal);
        REGISTRY.setWarrant(agent, WarrantRegistry.Warrant(100_000, 100, 150, 50, true, true, true, 0));
    }

    /// Identity v2.0.0: agentWallet changes only with the new wallet's EIP-712 signature.
    function _bindWallet(uint256 id, address wallet, uint256 pk) internal {
        uint256 deadline = block.timestamp + 60;
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                IDENTITY
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                id,
                wallet,
                operator,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.prank(operator);
        IIdentityFull(IDENTITY).setAgentWallet(id, wallet, deadline, abi.encodePacked(r, s, v));
    }

    function _a(bytes32 quote, uint8 verdict) internal view returns (WarrantAttestor.PreflightAttestation memory) {
        return WarrantAttestor.PreflightAttestation(principal, agent, quote, 1, verdict, keccak256("scorecard"));
    }

    function _sign(WarrantAttestor.PreflightAttestation memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, att.digest(a));
        return abi.encodePacked(r, s, v);
    }

    function _count(string memory tag2) internal view returns (uint64 n) {
        address[] memory clients = new address[](1);
        clients[0] = address(bridge);
        (n,,) = IReputationRead(REPUTATION).getSummary(agentId, clients, "warrant-preflight", tag2);
    }

    function test_verifiedAttestationsBecomeReputation() public {
        WarrantAttestor.PreflightAttestation memory pass = _a(keccak256("q1"), 0);
        WarrantAttestor.PreflightAttestation memory fail = _a(keccak256("q2"), 2);
        vm.startPrank(relayer);
        bridge.submitAndRate(pass, _sign(pass), agentId);
        bridge.submitAndRate(fail, _sign(fail), agentId);
        vm.stopPrank();

        assertEq(_count(""), 2);
        assertEq(_count("fail"), 1);
        (int128 value, uint8 dec, string memory tag1, string memory tag2, bool revoked) =
            IReputationRead(REPUTATION).readFeedback(agentId, address(bridge), 2);
        assertEq(value, 1);
        assertEq(dec, 0);
        assertEq(tag1, "warrant-preflight");
        assertEq(tag2, "fail");
        assertFalse(revoked);
        assertTrue(att.submitted(att.digest(fail)));
    }

    /// Someone submitting straight to the attestor first cannot deny the agent its feedback.
    function test_alreadySubmittedAttestationIsStillRated() public {
        WarrantAttestor.PreflightAttestation memory a = _a(keccak256("q3"), 0);
        att.submit(a, _sign(a));
        bridge.submitAndRate(a, "", agentId); // signature not needed: the attestor already verified it
        assertEq(_count("pass"), 1);
    }

    function test_rateTwiceReverts() public {
        WarrantAttestor.PreflightAttestation memory a = _a(keccak256("q4"), 0);
        bytes memory sig = _sign(a);
        bridge.submitAndRate(a, sig, agentId);
        vm.expectRevert(abi.encodeWithSelector(WarrantReputation.AlreadyRated.selector, att.digest(a)));
        bridge.submitAndRate(a, sig, agentId);
    }

    /// An attestation cannot be credited to an ERC-8004 identity whose agentWallet is someone else.
    function test_wrongIdentityReverts() public {
        vm.prank(operator);
        uint256 otherId = IIdentityFull(IDENTITY).register("data:application/json;base64,e30=");
        WarrantAttestor.PreflightAttestation memory a = _a(keccak256("q5"), 0);
        bytes memory sig = _sign(a); // outside expectRevert: _sign makes an external call
        vm.expectRevert(abi.encodeWithSelector(WarrantReputation.NotAgentWallet.selector, otherId, operator, agent));
        bridge.submitAndRate(a, sig, otherId);
    }

    /// Unverified attestations never reach the reputation registry.
    function test_badSignatureNotRated() public {
        WarrantAttestor.PreflightAttestation memory a = _a(keccak256("q6"), 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, att.digest(a));
        vm.expectPartialRevert(WarrantAttestor.NotSignedByAgent.selector);
        bridge.submitAndRate(a, abi.encodePacked(r, s, v), agentId);
        assertEq(_count(""), 0);
    }
}
