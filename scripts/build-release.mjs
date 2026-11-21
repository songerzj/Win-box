// Release-only build（本仓扩展：目标平台开关 / 原生桥前置校验 / LICENSE 兜底）。
//
// ★ 2026-10-15（合并上游 1.21.5）：上游把「赞赏图 / 加群二维码」功能**整条删除**
//   （src/build/supportImage.ts、vite 别名、关于页弹窗），本仓随之移除
//   `--allow-placeholder` 与「产物里含原图」的 SHA256 校验。
//   副作用（好的那种）：现在打包**不再需要任何私有素材**，从零 clone 的仓库可直接出包。
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ★ 2026-11-18：出包后的机器门禁 —— 发布包里绝不能混进本地跑出来的 userdata。
//   以前只靠 docs/memory-notes.md 的人工提醒「测完删 win-unpacked/data」，忘了就漏。
//   现在打包成功后扫描产出目录，命中 data 用户数据目录就 exit 1。
//   扫描时整棵跳过随包工具树（jvm / mpv / ffmpeg / jre / ...），避免把它们自带的
//   同名目录误判成用户数据 —— 源码 resources/jvm/... 的正常目录绝不能被拦。
const BUNDLED_TOOL_TREE = /(?:^|[\\/])(?:jvm|mpv|ffmpeg|aria2|native-bridge|python-runner|d2j|libs|stubs|stubs-src|shell-shim|tools|okhttp4-compat|prefs-shim|jre|locales|node_modules)(?:[\\/]|$)/i;

/** electron-builder 的产出目录取自 package.json 的 build.directories.output。 */
function packagedOutputDir() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const output = pkg?.build?.directories?.output;
  if (typeof output !== 'string' || !output.trim()) {
    console.warn('[userdata-gate] package.json 缺少 build.directories.output，跳过 userdata 检查。');
    return '';
  }
  return resolve(root, output.trim());
}

/** 递归找出产出目录里疑似用户数据的 data 目录（不含随包工具树内的同名目录）。 */
function findPackagedUserData(outputDir) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      const rel = full.slice(outputDir.length + 1);
      if (BUNDLED_TOOL_TREE.test(rel)) continue;
      if (entry.name.toLowerCase() === 'data') {
        hits.push(full);
        continue;
      }
      walk(full, depth + 1);
    }
  };
  walk(outputDir, 0);
  return hits;
}

/** 命中即列出路径并 exit 1；通过则打一行 PASS。 */
function assertNoPackagedUserData() {
  const outputDir = packagedOutputDir();
  if (!outputDir || !existsSync(outputDir)) return;
  const hits = findPackagedUserData(outputDir);
  if (hits.length) {
    console.error('[userdata-gate] 发布包内检测到用户数据目录 —— 这些是本地跑出来的订阅/历史/凭据，绝不能进发布包：');
    for (const p of hits) console.error(`  · ${p}`);
    console.error('[userdata-gate] 请删除上述目录后重新打包。');
    process.exit(1);
  }
  console.log('[userdata-gate] 发布包内无用户数据目录，PASS');
}

// 维护/自测入口：只跑产物门禁、不触发打包（CI 与日常构建完全不受影响）。
if (process.env.WINBOX_CHECK_USERDATA_ONLY === '1') {
  assertNoPackagedUserData();
  process.exit(0);
}

// ★ 2026-10-12（macOS 适配 · T04）：目标平台开关。
//   --mac  → electron-builder `--mac dmg zip`（产出 arm64 + x64 的 dmg 与 zip）
//   --win  → 与原脚本完全一致的 `--win nsis`
//   无参数  → 默认 Windows（★ 零回归红线：默认分支的行为一字不改）
const argv = process.argv.slice(2).filter(a => a !== '--');
const unknown = argv.filter(a => !['--mac', '--win', '--dry-run', '--allow-no-bridge'].includes(a));
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(' ')}`);
  console.error('Usage: node scripts/build-release.mjs [--win | --mac] [--dry-run] [--allow-no-bridge]');
  process.exit(1);
}
const target = argv.includes('--mac') ? 'mac' : 'win';
const dryRun = argv.includes('--dry-run');
const builderArgs = target === 'mac'
  ? ['--mac', 'dmg', 'zip', '--publish', 'never']
  : ['--win', 'nsis', '--publish', 'never'];

const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(['scripts/build-main.mjs']);
run(['node_modules/vite/bin/vite.js', 'build']);

// ★ 2026-10-14：原生桥 jar 必须随包 —— 缺了它，**所有含 .so 的加固壳源**在桌面上只能报
//   「该源依赖安卓原生库（.so），桌面版无法加载（架构限制，非移植缺陷）」（见 JarSpiderBridge
//   的 translateSpiderLog）。而这只 jar 曾经不入库，加上唯一的构建脚本 build.ps1 是 PowerShell，
//   mac 上从零 clone 的仓库里就根本没有它 —— 这是 mac 适配里最隐蔽的一处缺口。
//
// ★ 2026-10-15：把关从「只挂 mac 分支」提为**平台无关**。
//   原先只查 mac 的理由是「Windows 主开发机历史上一直有它（本地构建产物）」——
//   但自 c2ca033 起这只 jar 已随源码入库，那个理由不再成立；而 Windows 分支一旦本地误删
//   就会**静默**打出一个「无原生桥」的包，用户拿到后所有加固壳源全废且毫无提示。
//   现在两个平台都强制校验；确需出降级包时用 --allow-no-bridge 显式放行（行为对 mac 不变）。
if (!argv.includes('--allow-no-bridge')) {
  const bridge = join(root, 'resources/jvm/native-bridge/native-bridge.jar');
  if (!existsSync(bridge)) {
    console.error(`缺少 resources/jvm/native-bridge/native-bridge.jar —— 缺了它，含 .so 的加固壳源在桌面端全部不可用（报「依赖安卓原生库」）。`);
    console.error(`  · 打包目标：${target}`);
    console.error('  · 正常情况下该 jar 已随源码入库，先 git status 确认是不是被误删；');
    console.error('  · 需要重建时：node resources/jvm/native-bridge/build-native-bridge.mjs（或 pnpm build:native-bridge）');
    console.error('  · 确实要出「无原生桥」的降级包：加 --allow-no-bridge');
    process.exit(1);
  }
  console.log(`native bridge verified: ${bridge}`);
} else {
  console.warn('⚠ --allow-no-bridge：跳过原生桥校验，本包内所有含 .so 的加固壳源将不可用。');
}

// macOS 前置检查：electron-builder 需要 build/icon.icns（icns 不入库，需先在 Mac 上生成）。
// 只影响 --mac 分支；Windows 分支不读这个文件，行为不变。
if (target === 'mac') {
  const icns = join(root, 'build/icon.icns');
  if (!existsSync(icns)) {
    console.error('Missing build/icon.icns — 先在 macOS 上执行：`node scripts/make-icon.mjs`（用系统自带 sips + iconutil 从 build/icon.png 生成）。');
    process.exit(1);
  }
  console.log(`macOS icon verified: ${icns}`);
}

// ★ 2026-10-13：`build.nsis.license` 指向 `LICENSE.txt`，而该文件被 .gitignore 主动排除
//   （正式发布机上放作者自己的协议文本，不入库）。
//   本机没有它 → NSIS 直接报 "cannot find specified resource LICENSE.txt" 而打包失败。
//   缺文件时退回仓库里已提交的 MIT `LICENSE`（复制到同样被忽略的 LICENSE.txt，不污染版本库）。
const licenseTxt = join(root, 'LICENSE.txt');
if (!existsSync(licenseTxt)) {
  const trackedLicense = join(root, 'LICENSE');
  if (!existsSync(trackedLicense)) {
    console.error('Missing LICENSE.txt（且仓库里也没有 LICENSE 可兜底）—— 请先准备协议文本再打包。');
    process.exit(1);
  }
  copyFileSync(trackedLicense, licenseTxt);
  console.warn(`⚠ 未找到 LICENSE.txt，已用仓库的 LICENSE（MIT）顶上；安装协议页会显示 MIT 文本。`);
}

const builderCmd = ['node_modules/electron-builder/out/cli/cli.js', ...builderArgs];
console.log(`electron-builder args: ${builderArgs.join(' ')}`);
if (dryRun) {
  console.log('Dry run: 不执行打包，仅打印将要执行的命令与前置校验结果。');
  process.exit(0);
}
run(builderCmd);

// ★ 2026-11-18：产物已生成 —— 机器断言包内无用户数据（订阅/历史/凭据），命中直接 exit 1。
assertNoPackagedUserData();
