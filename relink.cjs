#!/usr/bin/env node
/**
 * 本地开发修复：dual-package 陷阱。
 * 全局装的 mm CLI 和本插件各自带一份 @metamask/agent-wallet（同版本但物理两份），
 * 导致两个 PluginCommand 是不同类对象，宿主 instanceof 校验失败 → PLUGIN_INVALID_BASE。
 * 本脚本把本地那份换成指向全局同一份的目录 junction，让两边加载同一物理模块。
 *
 * ⚠️ 每次 `npm install` 后都要重跑：npm 会用真副本覆盖 junction。
 * ⚠️ 仅本地开发用（全局 mm 安装场景）；发布给终端用户时不需要，peer 依赖由宿主提供。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const local = path.join(__dirname, 'node_modules', '@metamask', 'agent-wallet');

// 定位全局 mm 自带的 agent-wallet
let globalRoot;
try {
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  globalRoot = path.join(npmRoot, '@metamask', 'agent-wallet');
} catch (e) {
  console.error('无法定位 npm 全局根：', e.message);
  process.exit(1);
}

if (!fs.existsSync(path.join(globalRoot, 'package.json'))) {
  console.error('全局未找到 @metamask/agent-wallet：', globalRoot);
  console.error('先 `npm i -g @metamask/agent-wallet` 装好 mm CLI 再跑本脚本。');
  process.exit(1);
}

try { fs.rmSync(local, { recursive: true, force: true }); } catch (e) {}
fs.mkdirSync(path.dirname(local), { recursive: true });
fs.symlinkSync(globalRoot, local, 'junction');

const v = require(path.join(local, 'package.json')).version;
console.log('✓ junction 已建：', local, '→', fs.realpathSync(local));
console.log('✓ 解析版本：', v);
