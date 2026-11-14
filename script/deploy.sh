#!/usr/bin/env bash
# Deploy the whole loop: Warrant + guardian on Ethereum Sepolia, sentinel on Reactive Lasna.
#
#   bash script/deploy.sh            # run every step that has not run yet
#
# Reads keys from .env (never printed). Writes addresses and tx hashes to deployments/sepolia.json,
# and skips any step whose result is already recorded there, so a failed run can be re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
_S=${SEPOLIA_RPC:-}; _L=${LASNA_RPC:-}   # values set by the caller win over .env
set -a; source .env; set +a

ORIGIN_CHAIN_ID=11155111
CALLBACK_PROXY=0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4 # dev.reactive.network/origins-and-destinations
LREACT_FAUCET=0x9b9BB25f1A81078C544C829c5EB7822d747Cf434  # dev.reactive.network/reactive-mainnet
S_RPC=${_S:-${SEPOLIA_RPC:?}}
L_RPC=${_L:-${LASNA_RPC:-https://lasna-rpc.rnk.dev/}}

LREACT_BUY=${LREACT_BUY:-0.03ether}          # 0.03 SepETH -> 3 lREACT (Lasna gas 100 gwei: sentinel deploy ~0.15)
SENTINEL_FUND=${SENTINEL_FUND:-1.5ether}       # lREACT kept on the sentinel for reactive txs
GUARDIAN_FUND=${GUARDIAN_FUND:-0.005ether}    # SepETH kept on the guardian for callbacks
AGENT_GAS=${AGENT_GAS:-0.005ether}           # SepETH for the agent's own txs
GUARDIAN_DUSD=${GUARDIAN_DUSD:-100000000000} # 100,000 dUSD (6 decimals) in the vault
AGENT_BUDGET=${AGENT_BUDGET:-1000000000}     # 1,000 dUSD the agent may draw
# maxUsdPerTradeCents, maxSlippageBps, maxPriceImpactBps, maxFeeBps, crossChain, newApproval, recipientSelf, expiresAt
WARRANT=${WARRANT:-"(50000,100,200,50,false,false,true,0)"}

OUT=${OUT:-deployments/sepolia.json}
mkdir -p "$(dirname "$OUT")"
[ -f "$OUT" ] || echo '{}' > "$OUT"
get() { jq -r --arg k "$1" '.[$k] // empty' "$OUT"; }
put() { local t; t=$(mktemp); jq --arg k "$1" --arg v "$2" '.[$k]=$v' "$OUT" > "$t" && mv "$t" "$OUT"; }

create() { # key rpc pk contract [--value v] [--constructor-args ...]
  local key=$1 rpc=$2 pk=$3 c=$4; shift 4
  if [ -n "$(get "$key")" ]; then echo "= $key $(get "$key")"; return; fi
  local j; j=$(forge create --broadcast --json --rpc-url "$rpc" --private-key "$pk" "$c" "$@")
  put "$key" "$(jq -r .deployedTo <<<"$j")"; put "${key}_tx" "$(jq -r .transactionHash <<<"$j")"
  echo "+ $key $(get "$key")  tx $(get "${key}_tx")"
}

send() { # key rpc pk to sig [args...]   (cast send; records the tx hash once)
  local key=$1 rpc=$2 pk=$3; shift 3
  if [ -n "$(get "$key")" ]; then echo "= $key $(get "$key")"; return; fi
  local j; j=$(cast send --json --rpc-url "$rpc" --private-key "$pk" "$@")
  [ "$(jq -r .status <<<"$j")" = "0x1" ] || { echo "! $key reverted: $(jq -r .transactionHash <<<"$j")"; exit 1; }
  put "$key" "$(jq -r .transactionHash <<<"$j")"
  echo "+ $key $(get "$key")"
}

PK=$PRINCIPAL_PRIVATE_KEY
echo "principal $PRINCIPAL_ADDRESS  sepolia $(cast balance "$PRINCIPAL_ADDRESS" -e --rpc-url "$S_RPC") ETH  lasna $(cast balance "$PRINCIPAL_ADDRESS" -e --rpc-url "$L_RPC") lREACT"

# 1. lREACT for the sentinel (arrives on Lasna a little later)
send lreact_request "$S_RPC" "$PK" "$LREACT_FAUCET" "request(address)" "$PRINCIPAL_ADDRESS" --value "$LREACT_BUY"

# 2. Origin side: the Warrant contracts (unchanged, from lib/warrant) and the demo asset
create registry "$S_RPC" "$PK" lib/warrant/contracts/src/WarrantRegistry.sol:WarrantRegistry
create attestor "$S_RPC" "$PK" lib/warrant/contracts/src/WarrantAttestor.sol:WarrantAttestor --constructor-args "$(get registry)"
create dusd "$S_RPC" "$PK" src/DemoUSD.sol:DemoUSD

# 3. Reactive side: wait for lREACT, then the sentinel
for _ in $(seq 1 60); do
  bal=$(cast balance "$PRINCIPAL_ADDRESS" --rpc-url "$L_RPC")
  [ "$bal" != "0" ] && break
  [ -n "$(get sentinel)" ] && break
  echo "  waiting for lREACT on Lasna..."; sleep 10
done
create sentinel "$L_RPC" "$PK" src/WarrantSentinel.sol:WarrantSentinel --value "$SENTINEL_FUND" \
  --constructor-args "$ORIGIN_CHAIN_ID" "$(get registry)" "$(get attestor)" "$(get dusd)"

# 4. The guardian names the sentinel as its only callback sender
create guardian "$S_RPC" "$PK" src/WarrantGuardian.sol:WarrantGuardian --value "$GUARDIAN_FUND" \
  --constructor-args "$CALLBACK_PROXY" "$(get sentinel)" "$(get registry)" "$(get dusd)" "$PRINCIPAL_ADDRESS"

# 5. Sentinel subscribes to everything keyed on the guardian
send set_guardian "$L_RPC" "$PK" "$(get sentinel)" "setGuardian(address)" "$(get guardian)"
echo "  giving the new subscriptions a moment..."; sleep 20

# 6. Fund the vault, grant the agent its Warrant and budget, give it gas
send mint_vault "$S_RPC" "$PK" "$(get dusd)" "mint(address,uint256)" "$(get guardian)" "$GUARDIAN_DUSD"
send set_warrant "$S_RPC" "$PK" "$(get guardian)" \
  "setWarrant(address,(uint64,uint16,uint16,uint16,bool,bool,bool,uint64))" "$AGENT_ADDRESS" "$WARRANT"
send set_budget "$S_RPC" "$PK" "$(get guardian)" "setBudget(address,uint256)" "$AGENT_ADDRESS" "$AGENT_BUDGET"
send agent_gas "$S_RPC" "$PK" "$AGENT_ADDRESS" --value "$AGENT_GAS"

put origin_chain_id "$ORIGIN_CHAIN_ID"; put callback_proxy "$CALLBACK_PROXY"
put principal "$PRINCIPAL_ADDRESS"; put agent "$AGENT_ADDRESS"
echo
echo "Done. Check the sentinel picked up the agent (WarrantSet -> watch):"
echo "  cast call $(get sentinel) 'watched(address)(bool)' $AGENT_ADDRESS --rpc-url $L_RPC"
echo "If it says false after a minute, run:  cast send $(get sentinel) 'watch(address)' $AGENT_ADDRESS (as principal on Lasna)"
