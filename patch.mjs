#!/usr/bin/env node
/**
 * 把 DSH 输入框的回车改成：**Enter 插入换行，Ctrl/Cmd+Enter 提交**。
 *
 * 用法：
 *   node patch.mjs              # 打补丁（幂等：已打过会跳过）
 *   node patch.mjs --check      # 只看状态，不写文件
 *   node patch.mjs --revert     # 撤销补丁
 *   node patch.mjs --target <client.js 的绝对路径>   # 指定别的安装位置
 *
 * 逻辑与锚点说明见 lib/patch-core.mjs；背景与取舍见 README.md。
 * dsh 升级会覆盖 node_modules，升级后重新跑一次本脚本即可。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_SUFFIX, MARKER, applyPatch, resolveTarget, revertPatch } from './lib/patch-core.mjs';

/** 读取命令行里的 --target 值。 */
function targetFromArgv(argv) {
  const at = argv.indexOf('--target');
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error('--target 后面要跟 client.js 的路径');
  return value;
}

/**
 * 用 Node 自己给写入后的产物做一次语法检查。
 * 产物是 ESM，而目标文件叫 .js（包内不一定声明 type: module），所以复制成 .mjs 再 `node --check`。
 * 这是「改坏了不如不改」的最后一道闸：插错位置会在这里直接暴露。
 * @param {string} content 写入后的文件内容
 */
function assertSyntax(content) {
  const probe = join(tmpdir(), `dsh-enter-newline-check-${process.pid}.mjs`);
  writeFileSync(probe, content);
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
  } catch (error) {
    const detail = error.stderr === undefined ? error.message : String(error.stderr).trim();
    throw new Error(`改完的产物没通过语法检查，已放弃写入：\n${detail}`);
  } finally {
    rmSync(probe, { force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const revert = argv.includes('--revert');
  const target = targetFromArgv(argv) ?? resolveTarget();

  if (!existsSync(target)) throw new Error(`目标文件不存在：${target}`);
  const source = readFileSync(target, 'utf8');
  const patched = source.includes(MARKER);

  console.log(`目标文件：${target}`);
  console.log(`当前状态：${patched ? '已打补丁' : '未打补丁'}`);
  if (check) return;

  if (revert) {
    if (!patched) {
      console.log('无需撤销。');
      return;
    }
    const restored = revertPatch(source);
    assertSyntax(restored);
    writeFileSync(target, restored);
    console.log('已撤销补丁：Enter 恢复为「提交」，Shift+Enter 仍是换行。刷新页面即可。');
    return;
  }

  if (patched) {
    console.log('已经打过补丁，跳过。');
    return;
  }
  const next = applyPatch(source);
  assertSyntax(next);
  const backup = `${target}${BACKUP_SUFFIX}`;
  if (!existsSync(backup)) copyFileSync(target, backup);
  writeFileSync(target, next);
  console.log(`已打补丁。原始副本：${backup}`);
  console.log('现在是：Enter 插入换行；Ctrl/Cmd+Enter 提交（运行时为空草稿且有排队消息时=插话发送全部排队）。');
  console.log('客户端 HMR 每 500ms 轮询一次这个 bundle，改完就会热加载；刷新一次页面最稳妥。');
}

main();
