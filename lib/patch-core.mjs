/**
 * 「Enter 插入换行、Ctrl/Cmd+Enter 提交」补丁的**纯逻辑**部分（不碰文件系统、不读命令行）。
 *
 * ## 为什么是一个补丁而不是一个插件
 * 输入框（composer）的回车判定只有一处：`dsh-client-ui-conversation` 的客户端产物里
 * 注册在 Lexical 编辑器上的 `KEY_ENTER_COMMAND`（优先级 4，最高）。它现在的逻辑是
 * 「任何形式的 Enter 都提交，只有 Shift+Enter 放行给编辑器」。
 *
 * 想「插入换行」，唯一的正路就是**放行给编辑器默认处理** —— 也就是 Shift+Enter 今天走的
 * 那条路：处理器 `return false` 之后，Lexical 内部的默认监听
 * （同文件里 `INSERT_LINE_BREAK_COMMAND → selection.insertLineBreak(false)`）会把换行插进去。
 * 插件层没有这条通路：它能拿到的只有 `arbitrate` 这个「要不要吃掉这个键」的投票口，
 * 吃掉之后要么什么都不发生，要么只能用 `execCommand` 之类去猜编辑器的内部状态
 * （而 Lexical 对 `beforeinput: insertLineBreak` 的处理又会把 `KEY_ENTER_COMMAND`
 * 再派发一次，极可能绕回「提交」）。所以这里选择改编译产物，并且把改动压缩到**一行守卫**。
 *
 * ## 五处改动（锚点全部要求唯一，找不到或不止一处就报错退出，绝不瞎改）
 * 1. 【核心】composer 的 `KEY_ENTER_COMMAND` 处理器里、无条件 `preventDefault()` 之前插入：
 *    真实键盘事件且没按 Ctrl/Cmd 时 `return false` → 交回编辑器默认 = 插入换行。
 *    Shift+Enter、`/` `@` 弹窗确认、输入法组合期、Alt 组合键的处理都在它之前，一律不受影响；
 *    `event === null` 的那条既有路径（文本插入以换行结尾）也刻意不动（守卫要求 `event !== null`）。
 * 2. 【设置 → 快捷键】「发送消息」行：展示用的 keys 与绑定元数据由裸 Enter 改为 Ctrl/Cmd+Enter。
 * 3. 【设置 → 快捷键】「换行」行：展示用的 keys 由 Shift+Enter 改为 Enter，
 *    绑定元数据补上裸 Enter（Shift+Enter 依旧有效）。改动 2+3 之后，
 *    三行固定快捷键登记的绑定**并集与原来完全相同**（裸 Enter、Shift+Enter、Ctrl+Enter、Cmd+Enter），
 *    所以不会牵连别处的冲突检测。
 * 4. 【设置 → 通用】「繁忙时的发送行为」那句中文说明：Enter 不再提交，改成「发送按钮的行为」。
 * 5. 同上，英文说明。
 *
 * 「使用互补的 Queue／Steer 方式（Cmd/Ctrl+Enter）」那一行**不改**：它说的是运行时按设置取
 * 互补行为，改动后依然成立（`fixed.complementary`）。
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 幂等标记：文件里出现它就说明补丁已生效。 */
export const MARKER = 'LOCAL-PATCH:enter-newline';
/** 目标包名与其客户端入口（相对包根）。 */
export const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-conversation';
/** 客户端入口相对包根的路径。 */
export const CLIENT_ENTRY = join('lib', 'client.js');
/** 首次打补丁时留的原始副本后缀（结尾不叫 .js，不会被客户端的 chunk 扫描规则命中）。 */
export const BACKUP_SUFFIX = '.orig-enter-newline';

/** 核心锚点：composer 的 KEY_ENTER_COMMAND 处理器里那一句 arbitrate 判定。 */
const CORE_ANCHOR = 'if (handlers.arbitrate("enter", false) !== "pass") {';
/** 锚点行之后必须原样出现的四行；最后一行（无条件 preventDefault）是插入位置。 */
const CORE_BLOCK_AFTER = [
  'event?.preventDefault();',
  'return true;',
  '}',
  'event?.preventDefault();',
];
/** 插进去的注释（含幂等标记）。 */
const CORE_COMMENT = `/* ${MARKER} 裸 Enter（未按 Ctrl/Cmd）交回编辑器默认处理，与 Shift+Enter 同一条路径：结果是插入换行。原文此处对所有 Enter 一律提交 */`;
/** 插进去的守卫：只放行没有 Ctrl/Meta 的真实键盘事件。 */
const CORE_GUARD = 'if (event !== null && event.ctrlKey !== true && event.metaKey !== true) return false;';

/** 设置→快捷键「发送消息」行的锚点。 */
const SEND_ANCHOR = 'id: "fixed.send",';
/** 设置→快捷键「换行」行的锚点。 */
const NEWLINE_ANCHOR = 'id: "fixed.newline",';

/**
 * 代码块描述：[相对缩进层级, 该行去掉缩进后的内容]。
 * 层级 0 = 与锚点行同缩进，1 = 再缩进一级（拼接时用制表符，与原产物一致）。
 */
const SEND_OLD_LINES = [
  [0, 'keys: ["Enter"],'],
  [0, 'bindings: [{'],
  [1, 'code: "Enter",'],
  [1, 'modifiers: []'],
  [0, '}],'],
];
const SEND_NEW_LINES = [
  [0, 'keys: scope.shortcuts.describeBinding({'],
  [1, 'code: "Enter",'],
  [1, 'modifiers: ["primary"]'],
  [0, '}).keys,'],
  [0, 'bindings: [{'],
  [1, 'code: "Enter",'],
  [1, 'modifiers: ["control"]'],
  [0, '}, {'],
  [1, 'code: "Enter",'],
  [1, 'modifiers: ["meta"]'],
  [0, '}],'],
];
const NEWLINE_OLD_LINES = [
  [0, 'keys: scope.shortcuts.describeBinding({'],
  [1, 'code: "Enter",'],
  [1, 'modifiers: ["shift"]'],
  [0, '}).keys,'],
  [0, 'bindings: [{'],
  [1, 'code: "Enter",'],
  [1, 'modifiers: ["shift"]'],
  [0, '}],'],
];
const NEWLINE_NEW_LINES = [
  [0, 'keys: ["Enter"],'],
  [0, 'bindings: [{'],
  [1, 'code: "Enter",'],
  [1, 'modifiers: []'],
  [0, '}, {'],
  [1, 'code: "Enter",'],
  [1, 'modifiers: ["shift"]'],
  [0, '}],'],
];

/** 设置→通用「繁忙时的发送行为」说明：改动前后的原文（按行尾匹配，省得关心缩进）。 */
const DESC_BEFORE = {
  zh: '"settings.enter.description": "智能体运行时 Enter 键和发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为",',
  en: '"settings.enter.description": "What Enter and the Send button do while the agent is running; Cmd/Ctrl+Enter uses the other behavior",',
};
const DESC_AFTER = {
  zh: '"settings.enter.description": "智能体运行时发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为",',
  en: '"settings.enter.description": "What the Send button does while the agent is running; Cmd/Ctrl+Enter uses the other behavior",',
};

/** KEY_ENTER_COMMAND 处理器的注册片段（测试要从补丁后的产物里把这段函数抠出来直接执行）。 */
export const HANDLER_ANCHOR = 'registerCommand(cn$1, (event) => {';

/**
 * 解析 dsh 实际加载的那个 client.js：从 profile 的 package.json 出发按 Node 解析规则找包，
 * 这样 profile 用符号链接指向哪个安装目录就跟到哪个目录，不写死全局安装路径。
 * @returns {string} client.js 的绝对路径
 */
export function resolveTarget() {
  const anchors = [
    join(homedir(), '.dsh', 'profiles', 'web', 'package.json'),
    join(homedir(), '.dsh', 'profiles', 'package.json'),
  ];
  const failures = [];
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor);
      const manifest = require.resolve(`${PACKAGE_NAME}/package.json`);
      return join(dirname(manifest), CLIENT_ENTRY);
    } catch (error) {
      failures.push(`${anchor} → ${error.message}`);
    }
  }
  throw new Error(
    `无法从 profile 里解析 ${PACKAGE_NAME}，请用 --target 指定 client.js 路径。尝试过的锚点：\n  ${failures.join('\n  ')}`,
  );
}

/** 取一行的前导空白，插入/重建代码行时沿用同一缩进。 */
function indentOf(line) {
  return line.slice(0, line.length - line.trimStart().length);
}

/**
 * 在一行集合里找出唯一匹配的行号，匹配数不是 1 就抛错。
 * 这是本脚本的安全阀：dsh 升级后若这段代码被改写，宁可直接失败，也不要改错地方。
 * @param {string[]} lines 文件按行切分的结果
 * @param {(line: string) => boolean} test 行判定
 * @param {string} what 锚点的中文描述，用于报错
 * @returns {number} 行号（0 基）
 */
function findLine(lines, test, what) {
  const hits = [];
  lines.forEach((line, index) => {
    if (test(line)) hits.push(index);
  });
  if (hits.length !== 1) {
    throw new Error(`锚点「${what}」匹配到 ${hits.length} 处，期望恰好 1 处；DSH 可能已升级并改写了这段代码，请重新核对补丁`);
  }
  return hits[0];
}

/**
 * 校验 from 开始的若干行（只比去掉缩进后的内容），不符就抛错并报出实际读到的内容。
 * @param {string[]} lines 文件行
 * @param {number} from 起始行号（0 基）
 * @param {Array<[number, string]>} block 期望的代码块
 * @param {string} what 用于报错的描述
 */
function expectBlock(lines, from, block, what) {
  block.forEach(([, text], offset) => {
    const actual = lines[from + offset];
    if (actual === void 0 || actual.trim() !== text) {
      throw new Error(`锚点「${what}」第 ${offset + 1} 行不匹配，期望 ${JSON.stringify(text)}，实际读到 ${JSON.stringify(actual)}`);
    }
  });
}

/** 按缩进层级把代码块渲染成整行。 */
function renderBlock(block, base) {
  return block.map(([depth, text]) => base + '\t'.repeat(depth) + text);
}

/**
 * 施加补丁：只做文本级替换，任何锚点缺失都抛错。
 * 先算出全部位置再自下而上落笔，避免插入/替换导致的行号位移。
 * @param {string} source 原始文件内容
 * @returns {string} 打补丁后的内容
 */
export function applyPatch(source) {
  const lines = source.split('\n');

  const coreIndex = findLine(lines, (line) => line.trim() === CORE_ANCHOR, 'composer 的 KEY_ENTER_COMMAND 处理器');
  expectBlock(lines, coreIndex + 1, CORE_BLOCK_AFTER.map((text) => [0, text]), '处理器里 arbitrate 之后的四行');
  const guardIndex = coreIndex + CORE_BLOCK_AFTER.length;

  const sendIndex = findLine(lines, (line) => line.trim() === SEND_ANCHOR, '「发送消息」固定快捷键');
  expectBlock(lines, sendIndex + 2, SEND_OLD_LINES, '「发送消息」行原有的 keys/bindings');
  const newlineIndex = findLine(lines, (line) => line.trim() === NEWLINE_ANCHOR, '「换行」固定快捷键');
  expectBlock(lines, newlineIndex + 2, NEWLINE_OLD_LINES, '「换行」行原有的 keys/bindings');

  const descZhIndex = findLine(lines, (line) => line.endsWith(DESC_BEFORE.zh), '中文「繁忙时的发送行为」说明');
  const descEnIndex = findLine(lines, (line) => line.endsWith(DESC_BEFORE.en), '英文「繁忙时的发送行为」说明');

  const coreIndent = indentOf(lines[coreIndex]);
  const edits = [
    { from: guardIndex, count: 0, text: [`${coreIndent}${CORE_COMMENT}`, `${coreIndent}${CORE_GUARD}`] },
    { from: sendIndex + 2, count: SEND_OLD_LINES.length, text: renderBlock(SEND_NEW_LINES, indentOf(lines[sendIndex])) },
    {
      from: newlineIndex + 2,
      count: NEWLINE_OLD_LINES.length,
      text: renderBlock(NEWLINE_NEW_LINES, indentOf(lines[newlineIndex])),
    },
    {
      from: descZhIndex,
      count: 1,
      text: [lines[descZhIndex].slice(0, -DESC_BEFORE.zh.length) + DESC_AFTER.zh],
    },
    {
      from: descEnIndex,
      count: 1,
      text: [lines[descEnIndex].slice(0, -DESC_BEFORE.en.length) + DESC_AFTER.en],
    },
  ];

  for (const edit of edits.sort((left, right) => right.from - left.from)) {
    lines.splice(edit.from, edit.count, ...edit.text);
  }
  return lines.join('\n');
}

/**
 * 撤销补丁：与 applyPatch 完全对称的逆操作。
 * 刻意不走备份文件——dsh 升级后备份是旧版本，还原回去只会制造更糟的错配。
 * @param {string} source 已打补丁的文件内容
 * @returns {string} 还原后的内容
 */
export function revertPatch(source) {
  const lines = source.split('\n');

  const markerIndex = findLine(lines, (line) => line.includes(MARKER), '补丁标记');
  expectBlock(lines, markerIndex + 1, [[0, CORE_GUARD]], '补丁标记后面那行守卫');

  const sendIndex = findLine(lines, (line) => line.trim() === SEND_ANCHOR, '「发送消息」固定快捷键');
  expectBlock(lines, sendIndex + 2, SEND_NEW_LINES, '「发送消息」行补丁后的 keys/bindings');
  const newlineIndex = findLine(lines, (line) => line.trim() === NEWLINE_ANCHOR, '「换行」固定快捷键');
  expectBlock(lines, newlineIndex + 2, NEWLINE_NEW_LINES, '「换行」行补丁后的 keys/bindings');

  const descZhIndex = findLine(lines, (line) => line.endsWith(DESC_AFTER.zh), '中文说明（补丁后）');
  const descEnIndex = findLine(lines, (line) => line.endsWith(DESC_AFTER.en), '英文说明（补丁后）');

  const edits = [
    { from: markerIndex, count: 2, text: [] },
    { from: sendIndex + 2, count: SEND_NEW_LINES.length, text: renderBlock(SEND_OLD_LINES, indentOf(lines[sendIndex])) },
    {
      from: newlineIndex + 2,
      count: NEWLINE_NEW_LINES.length,
      text: renderBlock(NEWLINE_OLD_LINES, indentOf(lines[newlineIndex])),
    },
    {
      from: descZhIndex,
      count: 1,
      text: [lines[descZhIndex].slice(0, -DESC_AFTER.zh.length) + DESC_BEFORE.zh],
    },
    {
      from: descEnIndex,
      count: 1,
      text: [lines[descEnIndex].slice(0, -DESC_AFTER.en.length) + DESC_BEFORE.en],
    },
  ];

  for (const edit of edits.sort((left, right) => right.from - left.from)) {
    lines.splice(edit.from, edit.count, ...edit.text);
  }
  return lines.join('\n');
}

/**
 * 从产物里把 composer 的 KEY_ENTER_COMMAND 处理器函数源码抠出来（含 `(event) => {` 到配对的 `}`）。
 * 测试拿它直接执行，验的是**补丁后的真实代码**，而不是复刻一份逻辑来自我验证。
 * @param {string} source 已经打上（或尚未打上）补丁的文件内容
 * @returns {string} 处理器函数源码，形如 `(event) => { ... }`
 */
export function extractEnterHandler(source) {
  const at = source.indexOf(HANDLER_ANCHOR);
  if (at < 0) throw new Error(`找不到处理器锚点 ${JSON.stringify(HANDLER_ANCHOR)}`);
  if (source.indexOf(HANDLER_ANCHOR, at + 1) !== -1) throw new Error('处理器锚点在文件里出现了多次，无法确定要执行哪一个');
  const prefix = 'registerCommand(cn$1, ';
  const bodyStart = at + prefix.length;
  const braceStart = at + HANDLER_ANCHOR.length - 1;
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error('处理器函数的花括号没有配对，产物可能被改写过');
}
