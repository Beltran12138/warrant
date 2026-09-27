/**
 * Local RPC shim for `mm` on chains its RPC proxy does not serve yet.
 *
 * mm 6.2.0 lists Monad testnet (10143) but MetaMask's RPC proxy answers `Invalid chainId` for it, so
 * `mm wallet send-transaction --chain-id 10143` fails before the wallet is asked to sign. mm reads
 * its RPC base URL from MM_INFURA_RPC_BASE_URL and calls `<base>/<chainId>/<projectId>`; this shim
 * serves that path and forwards the JSON-RPC body to a public endpoint for the chain.
 *
 *   node scripts/mm-rpc-shim.mjs
 *   MM_INFURA_RPC_BASE_URL=http://127.0.0.1:47812 mm wallet send-transaction --chain-id 10143 ...
 *
 * Signing and broadcasting still happen in the mm wallet service; the shim only answers the reads
 * mm makes while preparing the transaction (block, nonce, balance). Chains not listed below get a
 * 400 so they fail loudly instead of silently hitting the wrong network. Listens on loopback only.
 */
import http from "node:http";

const PORT = Number(process.env.SHIM_PORT ?? 47812);
const UPSTREAM = {
  10143: "https://testnet-rpc.monad.xyz",
  43113: "https://api.avax-test.network/ext/bc/C/rpc",
};

http
  .createServer(async (req, res) => {
    const chainId = Number(req.url.split("/")[1]);
    const upstream = UPSTREAM[chainId];
    let body = "";
    for await (const chunk of req) body += chunk;
    let method = "?";
    try {
      const m = JSON.parse(body);
      method = Array.isArray(m) ? m.map((x) => x.method).join(",") : m.method;
    } catch {}
    // The path carries mm's project id; log the chain and method only.
    console.log(`${new Date().toISOString().slice(11, 19)} chain=${chainId} ${method}${upstream ? "" : " (not served)"}`);
    if (!upstream) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `chain ${chainId} is not served by mm-rpc-shim` }));
    }
    try {
      const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(await r.text());
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mm-rpc-shim on http://127.0.0.1:${PORT} → chains ${Object.keys(UPSTREAM).join(", ")}`));
