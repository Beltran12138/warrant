// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WarrantRegistry} from "../src/WarrantRegistry.sol";
import {WarrantAttestor} from "../src/WarrantAttestor.sol";
import {WarrantPriceCheck, IAggregatorV3} from "../src/WarrantPriceCheck.sol";
import {WarrantValidator, IERC8004Validation} from "../src/WarrantValidator.sol";

interface IArcIdentity {
    function register(string memory agentURI) external returns (uint256 agentId);
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
}

interface IArcValidationRead {
    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash) external;
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse);
}

/// WarrantValidator on an Arc mainnet fork: the deployed WarrantPriceCheck (live Chainlink feeds) and
/// Arc's ERC-8004 v2.0.0 ValidationRegistry.
/// forge test --match-contract ArcValidatorForkTest   (needs network access to the Arc RPC)
contract ArcValidatorForkTest is Test {
    WarrantPriceCheck constant PC = WarrantPriceCheck(0xdF3fE689F0a3C74Ce299018cB573870769f04571);
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant VALIDATION = 0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58;
    address constant USDC_USD = 0x84EA90AC252Dc437031461836DB5164219147905;
    address constant EURC_USD = 0x361b95c10b76Ca3f35C686d423e43A951755Bf23;
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;

    WarrantValidator v;
    WarrantAttestor att;
    address operator = makeAddr("agent-operator");
    address principal = makeAddr("principal");
    uint256 agentPk = 0xA11CE;
    address agent;
    uint256 agentId;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arc"));
        agent = vm.addr(agentPk);
        att = PC.attestor();
        v = new WarrantValidator(PC, IERC8004Validation(VALIDATION));
        vm.prank(operator);
        agentId = IArcIdentity(IDENTITY).register("data:application/json;base64,e30=");
        _bind(agentId, operator, agent, agentPk);
        WarrantRegistry reg = PC.registry();
        vm.prank(principal);
        reg.setWarrant(agent, WarrantRegistry.Warrant(100_000, 100, 150, 50, true, true, true, 0));
    }

    function _bind(uint256 id, address owner, address wallet, uint256 pk) internal {
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
            abi.encode(keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"), id, wallet, owner, deadline)
        );
        (uint8 v_, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        vm.prank(owner);
        IArcIdentity(IDENTITY).setAgentWallet(id, wallet, deadline, abi.encodePacked(r, s, v_));
    }

    function _fair() internal view returns (uint256) {
        (, int256 usd,,,) = IAggregatorV3(USDC_USD).latestRoundData();
        (, int256 eur,,,) = IAggregatorV3(EURC_USD).latestRoundData();
        return (0.5 ether * uint256(usd)) / (uint256(eur) * 1e12);
    }

    function _disclose(uint256 buyAmount, uint8 verdict, bytes32 q)
        internal
        returns (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t)
    {
        t = WarrantPriceCheck.QuoteTerms(q, address(0), EURC, 0.5 ether, buyAmount);
        a = WarrantAttestor.PreflightAttestation(principal, agent, PC.termsHash(t), 1, verdict, keccak256("scorecard"));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(agentPk, att.digest(a));
        att.submit(a, abi.encodePacked(r, s, vv));
    }

    function _request(bytes32 d, address validator) internal {
        vm.prank(operator);
        IArcValidationRead(VALIDATION).validationRequest(validator, agentId, "", d);
    }

    function _summary() internal view returns (uint64 n, uint8 avg) {
        address[] memory vs = new address[](1);
        vs[0] = address(v);
        return IArcValidationRead(VALIDATION).getSummary(agentId, vs, "warrant-oracle");
    }

    function test_honestDisclosureValidates100() public {
        (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t) =
            _disclose((_fair() * 9_950) / 10_000, 0, keccak256("q1"));
        _request(att.digest(a), address(v));
        assertEq(v.respond(a, t), 100);
        (uint64 n, uint8 avg) = _summary();
        assertEq(n, 1);
        assertEq(avg, 100);
    }

    function test_falsePassValidates0() public {
        (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t) =
            _disclose((_fair() * 9_500) / 10_000, 0, keccak256("q2"));
        _request(att.digest(a), address(v));
        assertEq(v.respond(a, t), 0);
        (uint64 n, uint8 avg) = _summary();
        assertEq(n, 1);
        assertEq(avg, 0);
    }

    function test_honestFailOnBadQuoteValidates100() public {
        (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t) =
            _disclose((_fair() * 9_500) / 10_000, 2, keccak256("q3"));
        _request(att.digest(a), address(v));
        assertEq(v.respond(a, t), 100);
    }

    function test_unrequestedReverts() public {
        (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t) =
            _disclose((_fair() * 9_950) / 10_000, 0, keccak256("q4"));
        vm.expectRevert(bytes("unknown"));
        v.respond(a, t);
    }

    function test_requestedFromAnotherValidatorReverts() public {
        (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t) =
            _disclose((_fair() * 9_950) / 10_000, 0, keccak256("q5"));
        _request(att.digest(a), makeAddr("other-validator"));
        vm.expectRevert(
            abi.encodeWithSelector(WarrantValidator.NotRequestedFromThisValidator.selector, att.digest(a), makeAddr("other-validator"))
        );
        v.respond(a, t);
    }

    function test_forgedTermsRevert() public {
        (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t) =
            _disclose((_fair() * 9_500) / 10_000, 0, keccak256("q6"));
        _request(att.digest(a), address(v));
        t.buyAmount = (_fair() * 9_990) / 10_000; // make the bad quote look fine
        vm.expectRevert(abi.encodeWithSelector(WarrantValidator.TermsMismatch.selector, a.quoteHash, PC.termsHash(t)));
        v.respond(a, t);
    }

    /// The validator and WarrantPriceCheck must agree on the same disclosure, at and around the tolerance edge.
    function test_agreesWithPriceCheck() public {
        uint16[6] memory bps = [uint16(9_990), 9_800, 9_701, 9_699, 9_500, 10_100]; // fraction of fair, in bps
        for (uint256 i; i < bps.length; ++i) {
            for (uint8 verdict; verdict <= 2; verdict += 2) {
                (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t) =
                    _disclose((_fair() * bps[i]) / 10_000, verdict, keccak256(abi.encode("agree", i, verdict)));
                _request(att.digest(a), address(v));
                uint8 response = v.respond(a, t);
                (, bool contradicted) = PC.check(a, t);
                assertEq(response == 0, contradicted, "validator and price check disagree");
            }
        }
    }

    /// Another identity owner asks for a credential on our agent's honest disclosure: refused.
    function test_credentialCannotBeBorrowed() public {
        (WarrantAttestor.PreflightAttestation memory a, WarrantPriceCheck.QuoteTerms memory t) =
            _disclose((_fair() * 9_950) / 10_000, 0, keccak256("q8"));
        address thief = makeAddr("thief");
        uint256 thiefPk = 0xBEEF;
        vm.prank(thief);
        uint256 thiefId = IArcIdentity(IDENTITY).register("data:application/json;base64,e30=");
        _bind(thiefId, thief, vm.addr(thiefPk), thiefPk);
        bytes32 d = att.digest(a);
        vm.prank(thief);
        IArcValidationRead(VALIDATION).validationRequest(address(v), thiefId, "", d);
        vm.expectRevert(abi.encodeWithSelector(WarrantValidator.NotAgentWallet.selector, thiefId, vm.addr(thiefPk), agent));
        v.respond(a, t);
    }

    function test_strangerCannotRequest() public {
        (WarrantAttestor.PreflightAttestation memory a,) = _disclose((_fair() * 9_950) / 10_000, 0, keccak256("q7"));
        bytes32 d = att.digest(a);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bytes("Not authorized"));
        IArcValidationRead(VALIDATION).validationRequest(address(v), agentId, "", d);
    }
}
