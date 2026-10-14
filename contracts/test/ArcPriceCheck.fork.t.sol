// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WarrantRegistry} from "../src/WarrantRegistry.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";
import {IERC8004Identity, IERC8004Reputation} from "../src/WarrantReputation.sol";
import {WarrantPriceCheck, IAggregatorV3} from "../src/WarrantPriceCheck.sol";

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

/// WarrantPriceCheck on an Arc mainnet fork: the deployed WarrantAttestor, Arc's live Chainlink
/// USDC/USD and EURC/USD feeds, and Arc's ERC-8004 v2.0.0 registries.
/// forge test --match-contract ArcPriceCheckForkTest   (needs network access to the Arc RPC)
contract ArcPriceCheckForkTest is Test {
    WarrantAttestor constant ATTESTOR = WarrantAttestor(0x33B7B8db2927783dEbb58a589CF5c7B95824fae1);
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;
    address constant USDC_USD = 0x84EA90AC252Dc437031461836DB5164219147905;
    address constant EURC_USD = 0x361b95c10b76Ca3f35C686d423e43A951755Bf23;
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;

    WarrantPriceCheck pc;
    address operator = makeAddr("agent-operator");
    address principal = makeAddr("principal");
    uint256 agentPk = 0xA11CE;
    address agent;
    uint256 agentId;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arc"));
        assertEq(block.chainid, 5042);
        agent = vm.addr(agentPk);

        address[] memory tokens = new address[](2);
        tokens[0] = address(0); // native USDC, 18 decimals
        tokens[1] = EURC;
        IAggregatorV3[] memory aggs = new IAggregatorV3[](2);
        aggs[0] = IAggregatorV3(USDC_USD);
        aggs[1] = IAggregatorV3(EURC_USD);
        uint8[] memory dec = new uint8[](2);
        dec[0] = 18;
        dec[1] = 6;
        uint32[] memory ages = new uint32[](2);
        ages[0] = 1 days + 1 hours; // both feeds: 24h heartbeat, 0.5% deviation threshold
        ages[1] = 1 days + 1 hours;
        pc = new WarrantPriceCheck(
            ATTESTOR, IERC8004Identity(IDENTITY), IERC8004Reputation(REPUTATION), 100, tokens, aggs, dec, ages
        );

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

        WarrantRegistry reg = ATTESTOR.registry();
        vm.prank(principal);
        reg.setWarrant(agent, WarrantRegistry.Warrant(100_000, 100, 150, 50, true, true, true, 0));
    }

    function _attest(WarrantPriceCheck.QuoteTerms memory t, uint8 verdict)
        internal
        returns (WarrantAttestor.PreflightAttestation memory a)
    {
        a = WarrantAttestor.PreflightAttestation(principal, agent, pc.termsHash(t), 1, verdict, keccak256("scorecard"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, ATTESTOR.digest(a));
        ATTESTOR.submit(a, abi.encodePacked(r, s, v));
    }

    function _count(string memory tag2) internal view returns (uint64 n) {
        address[] memory clients = new address[](1);
        clients[0] = address(pc);
        (n,,) = IArcReputationRead(REPUTATION).getSummary(agentId, clients, "warrant-oracle", tag2);
    }

    /// Fair output from the live feeds, recomputed here from the raw feed answers.
    function _fair(uint256 sellAmount) internal view returns (uint256) {
        (, int256 usd,,,) = IAggregatorV3(USDC_USD).latestRoundData();
        (, int256 eur,,,) = IAggregatorV3(EURC_USD).latestRoundData();
        return (sellAmount * uint256(usd)) / (uint256(eur) * 1e12); // 18 -> 6 decimals, both feeds 8 decimals
    }

    function test_liveFeedsPriceTheQuote() public view {
        uint256 fair = pc.fairOut(address(0), EURC, 0.5 ether);
        assertEq(fair, _fair(0.5 ether));
        assertGt(fair, 0.3e6); // sanity: EURC is worth between $1 and $1.67
        assertLt(fair, 0.5e6);
    }

    function test_honestPassIsConsistentOnArc() public {
        WarrantPriceCheck.QuoteTerms memory t =
            WarrantPriceCheck.QuoteTerms(keccak256("q-honest"), address(0), EURC, 0.5 ether, (_fair(0.5 ether) * 9_950) / 10_000);
        (, bool contradicted) = pc.checkAndRate(_attest(t, 0), t, agentId);
        assertFalse(contradicted);
        assertEq(_count("consistent"), 1);
    }

    function test_falsePassIsContradictedOnArc() public {
        WarrantPriceCheck.QuoteTerms memory t =
            WarrantPriceCheck.QuoteTerms(keccak256("q-bad"), address(0), EURC, 0.5 ether, (_fair(0.5 ether) * 9_500) / 10_000);
        (, bool contradicted) = pc.checkAndRate(_attest(t, 0), t, agentId);
        assertTrue(contradicted);
        assertEq(_count("contradicted"), 1);
        assertEq(_count("consistent"), 0);
    }
}
