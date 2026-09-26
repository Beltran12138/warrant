#!/usr/bin/env node
/**
 * Local-dev fix for the dual-package trap.
 * The global mm CLI and this plugin each carry a copy of @metamask/agent-wallet (same version, two
 * physical copies), so their PluginCommand classes differ and the host's instanceof check fails
 * with PLUGIN_INVALID_BASE. This replaces the local copy with a directory junction to the global one.
 *
 * Re-run after every `npm install`: npm overwrites the junction with a real copy.
 * Local development only; end users get the peer dependency from the host.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const local = path.join(__dirname, 'node_modules', '@metamask', 'agent-wallet');

// Locate the agent-wallet bundled with the global mm
let globalRoot;
try {
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  globalRoot = path.join(npmRoot, '@metamask', 'agent-wallet');
} catch (e) {
  console.error('Cannot locate the npm global root:', e.message);
  process.exit(1);
}

if (!fs.existsSync(path.join(globalRoot, 'package.json'))) {
  console.error('@metamask/agent-wallet not found globally:', globalRoot);
  console.error('Install the mm CLI first (`npm i -g @metamask/agent-wallet`), then re-run.');
  process.exit(1);
}

try { fs.rmSync(local, { recursive: true, force: true }); } catch (e) {}
fs.mkdirSync(path.dirname(local), { recursive: true });
fs.symlinkSync(globalRoot, local, 'junction');

const v = require(path.join(local, 'package.json')).version;
console.log('✓ junction created:', local, '→', fs.realpathSync(local));
console.log('✓ resolved version:', v);
