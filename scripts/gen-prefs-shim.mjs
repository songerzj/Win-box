// scripts/gen-prefs-shim.mjs — 生成 resources/jvm/prefs-shim/winbox-prefs-shim.jar
//
// 产物 = Node 端确定性生成的 `android/content/SharedPreferences$Mem` 替换类（见
// src/engine/spider/prefsShim.ts）。它让桌面端的 SharedPreferences **可读**（`<沙箱>/shared_prefs/seed.txt`
// 里的 `Wex_*` 键），从而修掉 某第三方源族「已绑定却报还没有配置 UC/百度 Cookie」。
//
// 为什么需要随构建现场产出：打包后 `resources/` 只读（asarUnpack），运行时无法落盘；且
// `resources/jvm/**/*.jar` 不进仓库（.gitignore）。生成逻辑只有一份真相（prefsShim.ts），
// 本脚本用 esbuild 现场 bundle 再调用，绝不复制粘贴类字节生成代码。
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const src = resolve(root, '..');
const tmpDir = join(src, '.tmp');

/**
 * 生成影子 jar。无需任何上游输入 —— 纯 Node 造类，永远可产出。
 * @returns {Promise<{outJar: string, bytes: number, entry: string}>}
 */
export async function generatePrefsShim() {
  const bundleFile = join(tmpDir, 'gen-prefs-shim.bundle.mjs');
  const entry = `
import { buildPrefsShimJar, PREFS_SHIM_JAR, PREFS_MEM_CLASS } from './src/engine/spider/prefsShim';
export { buildPrefsShimJar, PREFS_SHIM_JAR, PREFS_MEM_CLASS };
`;
  const result = await build({
    stdin: { contents: entry, resolveDir: src, sourcefile: 'gen-prefs-shim-entry.ts', loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'warning',
  });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(bundleFile, result.outputFiles[0].text);
  let mod;
  try {
    mod = await import(pathToFileURL(bundleFile).href);
  } finally {
    rmSync(bundleFile, { force: true });
  }

  const bytes = mod.buildPrefsShimJar();
  const outJar = join(src, 'resources/jvm/prefs-shim', mod.PREFS_SHIM_JAR);
  mkdirSync(dirname(outJar), { recursive: true });
  writeFileSync(outJar, bytes);
  return { outJar, bytes: bytes.length, entry: mod.PREFS_MEM_CLASS };
}

// 直接执行时打印结果（构建脚本里 import 调用时只返回值）
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = await generatePrefsShim();
  console.log(`prefs-shim 已生成: ${r.outJar} (${r.bytes} bytes, 影子类 ${r.entry})`);
}
