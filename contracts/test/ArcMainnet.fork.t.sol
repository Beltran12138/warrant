// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WarrantRegistry} from "../src/WarrantRegistry.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";
import {WarrantReputation, IERC8004Identity, IERC8004Reputation} from "../src/WarrantReputation.sol";

interface IArcIdentity {
    function register(string memory agentURI) external returns (uint256 agentId);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
}

interface IArcReputationRead {
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}

/// The full Warrant stack, freshly deployed on an Arc mainnet fork against Arc's live ERC-8004 v2.0.0
/// registries, before deploying it for real.
/// forge test --match-contract ArcMainnetForkTest   (needs network access to the Arc RPC)
contract ArcMainnetForkTest is Test {
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    WarrantRegistry reg;
    WarrantAttestor att;
    WarrantReputation bridge;
    address operator = makeAddr("agent-operator");
    address principal = makeAddr("principal");
    uint256 agentPk = 0xA11CE;
    address agent;
    uint256 agentId;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arc"));
        assertEq(block.chainid, 5042);
        agent = vm.addr(agentPk);
        reg = new WarrantRegistry();
        att = new WarrantAttestor(reg);
        bridge = new WarrantReputation(att, IERC8004Identity(IDENTITY), IERC8004Reputation(REPUTATION));

        vm.prank(operator);
        agentId = IArcIdentity(IDENTITY).register("data:application/json;base64,e30=");
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
                agentId,
                agent,
                operator,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.prank(operator);
        IArcIdentity(IDENTITY).setAgentWallet(agentId, agent, deadline, abi.encodePacked(r, s, v));

        vm.prank(principal);
        reg.setWarrant(agent, WarrantRegistry.Warrant(100_000, 100, 150, 50, true, true, true, 0));
    }

    function test_disclosureBecomesReputationOnArc() public {
        WarrantAttestor.PreflightAttestation memory a =
            WarrantAttestor.PreflightAttestation(principal, agent, keccak256("q1"), 1, 2, keccak256("scorecard"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, att.digest(a));
        bridge.submitAndRate(a, abi.encodePacked(r, s, v), agentId);

        assertTrue(att.submitted(att.digest(a)));
        address[] memory clients = new address[](1);
        clients[0] = address(bridge);
        (uint64 n,,) = IArcReputationRead(REPUTATION).getSummary(agentId, clients, "warrant-preflight", "fail");
        assertEq(n, 1);
    }
}
