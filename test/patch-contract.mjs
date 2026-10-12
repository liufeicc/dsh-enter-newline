/**
 * 补丁契约测试：`node test/patch-contract.mjs`
 *
 * 分三层验：
 * 1. **锚点与可逆性** —— 五个锚点在原始产物里是否唯一、打补丁/撤销是否严格互逆（逐字节比对）、重复打补丁是否报错。
 * 2. **判定表** —— 把补丁后产物里那段 `KEY_ENTER_COMMAND` 处理器**原样抠出来当函数执行**，
 *    用一个假事件跑完所有按键分支。测的是真正会被浏览器执行的代码，而不是复刻一份逻辑来自我验证。
 * 3. **设置页元数据** —— 快捷键行的展示键与绑定、说明文案；顺带验「绑定并集不变」这个不变量。
 *
 * 本测试只读文件，不改动任何东西。
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  BACKUP_SUFFIX,
  MARKER,
  applyPatch,
  extractEnterHandler,
  resolveTarget,
  revertPatch,
} from '../lib/patch-core.mjs';

let passed = 0;
const failures = [];

/**
 * 记一条断言。
 * @param {string} label 断言的中文描述
 * @param {boolean} condition 是否通过
 * @param {string} [detail] 失败时补充的实际值
 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail === void 0 ? label : `${label} —— 实际：${detail}`);
}

/** 打印结果并设置退出码。 */
function report() {
  for (const failure of failures) console.log(`FAIL  ${failure}`);
  console.log(`\n${passed} ok / ${failures.length} FAIL`);
  process.exit(failures.length === 0 ? 0 : 1);
}

//#region 装载原始产物
const target = resolveTarget();
const backup = `${target}${BACKUP_SUFFIX}`;
const live = readFileSync(target, 'utf8');
const livePatched = live.includes(MARKER);

let pristine;
if (existsSync(backup)) pristine = readFileSync(backup, 'utf8');
else if (!livePatched) pristine = live;
else throw new Error(`线上文件已打补丁但找不到原始副本 ${backup}，请先 node patch.mjs --revert 再跑测试`);

console.log(`目标文件：${target}`);
console.log(`线上状态：${livePatched ? '已打补丁' : '未打补丁'}；原始产物取自：${existsSync(backup) ? '备份副本' : '线上文件本身'}`);
//#endregion

//#region 1. 锚点、幂等与可逆性
const patched = applyPatch(pristine);
const restored = revertPatch(patched);

check('原始产物里没有补丁标记', !pristine.includes(MARKER));
check('打补丁后出现补丁标记', patched.includes(MARKER));
check('打补丁后标记只出现一次', patched.split(MARKER).length - 1 === 1, `${patched.split(MARKER).length - 1} 次`);
check('撤销后回到逐字节相同的原始产物', restored === pristine);
check('撤销后不再有补丁标记', !restored.includes(MARKER));

const GUARD = 'if (event !== null && event.ctrlKey !== true && event.metaKey !== true) return false;';
const ANCHORS = [
  'if (handlers.arbitrate("enter", false) !== "pass") {',
  'id: "fixed.send",',
  'id: "fixed.newline",',
  '"settings.enter.description": "智能体运行时 Enter 键和发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为",',
  '"settings.enter.description": "What Enter and the Send button do while the agent is running; Cmd/Ctrl+Enter uses the other behavior",',
];
for (const anchor of ANCHORS) {
  const count = pristine.split(anchor).length - 1;
  check(`原始产物里锚点唯一：${anchor.slice(0, 34)}…`, count === 1, `${count} 处`);
}
check('打补丁后守卫只插了一行', patched.split(GUARD).length - 1 === 1, `${patched.split(GUARD).length - 1} 行`);
check('打补丁后的行数比原来多 8 行（守卫 2 + 快捷键行 6）', patched.split('\n').length - pristine.split('\n').length === 8,
  `${patched.split('\n').length - pristine.split('\n').length} 行`);

let doubleApplyFailed = false;
try {
  applyPatch(patched);
} catch {
  doubleApplyFailed = true;
}
check('对已打补丁的内容再打一次会报错（幂等安全阀）', doubleApplyFailed);
let revertPristineFailed = false;
try {
  revertPatch(pristine);
} catch {
  revertPristineFailed = true;
}
check('对未打补丁的内容执行撤销会报错', revertPristineFailed);
check('线上文件与脚本产物自洽', livePatched ? live === patched : live === pristine);
//#endregion

//#region 2. 判定表：直接执行补丁后的真实处理器
/** 造一个够用的假键盘事件（真实代码只用到这几个字段）。 */
function keyEvent(overrides = {}) {
  const event = {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    getModifierState: () => false,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    ...overrides,
  };
  return event;
}

/**
 * 把抠出来的处理器包装成可调用的函数，并记录它做了哪些事。
 * @param {string} source 产物内容
 * @param {{arbitrate?: string, canSubmit?: boolean, composing?: boolean}} [stub] 外部状态的替身
 */
function harness(source, stub = {}) {
  const calls = { arbitrate: [], submit: [] };
  const handlers = {
    arbitrate: (key, composing) => {
      calls.arbitrate.push([key, composing]);
      return stub.arbitrate ?? 'pass';
    },
    canSubmit: () => stub.canSubmit ?? true,
    submit: (accelerated) => {
      calls.submit.push(accelerated);
    },
  };
  const isComposingEvent = () => stub.composing ?? false;
  const factory = new Function('handlers', 'isComposingEvent', 'recentlyComposing', `return ${extractEnterHandler(source)};`);
  return { handler: factory(handlers, isComposingEvent, () => false), calls };
}

/** 跑一个分支，返回结论。 */
function press(source, event, stub) {
  const rig = harness(source, stub);
  const returned = rig.handler(event);
  return { returned, calls: rig.calls, event };
}

// —— 补丁后：Enter 只换行 ——
{
  const event = keyEvent();
  const result = press(patched, event);
  check('裸 Enter：处理器放行（return false → 编辑器插入换行）', result.returned === false, String(result.returned));
  check('裸 Enter：没有 preventDefault（否则换行被挡）', event.prevented === false);
  check('裸 Enter：没有提交', result.calls.submit.length === 0, JSON.stringify(result.calls.submit));
  check('裸 Enter：arbitrate 仍被征询（弹窗确认优先）', JSON.stringify(result.calls.arbitrate) === JSON.stringify([['enter', false]]));
}
{
  const event = keyEvent({ repeat: true });
  const result = press(patched, event);
  check('长按 Enter：仍然只插入换行', result.returned === false && result.calls.submit.length === 0);
}
{
  const event = keyEvent({ shiftKey: true });
  const result = press(patched, event);
  check('Shift+Enter：行为不变（换行）', result.returned === false && result.calls.submit.length === 0);
}

// —— 补丁后：Ctrl/Cmd+Enter 提交 ——
for (const [label, modifier] of [['Ctrl+Enter', { ctrlKey: true }], ['Cmd+Enter', { metaKey: true }]]) {
  const event = keyEvent(modifier);
  const result = press(patched, event);
  check(`${label}：提交且 accelerated=true`, result.returned === true && JSON.stringify(result.calls.submit) === '[true]',
    JSON.stringify(result.calls.submit));
  check(`${label}：吃掉按键（preventDefault）`, event.prevented === true);
}
{
  const event = keyEvent({ ctrlKey: true });
  const result = press(patched, event, { canSubmit: false });
  check('Ctrl+Enter 但不可提交：吃掉按键、不提交', result.returned === true && result.calls.submit.length === 0 && event.prevented === true);
}
{
  const event = keyEvent({ ctrlKey: true, repeat: true });
  const result = press(patched, event);
  check('长按 Ctrl+Enter：只提交一次', result.returned === true && result.calls.submit.length === 0);
}

// —— 补丁后：其它修饰键组合一律保持原样（吃掉、什么都不做） ——
const untouched = [
  ['Alt+Enter', { altKey: true }],
  ['Ctrl+Meta+Enter', { ctrlKey: true, metaKey: true }],
  ['Ctrl+Shift+Enter', { ctrlKey: true, shiftKey: true }],
  ['Cmd+Shift+Enter', { metaKey: true, shiftKey: true }],
  ['AltGraph+Enter', { getModifierState: (name) => name === 'AltGraph' }],
];
for (const [label, overrides] of untouched) {
  const event = keyEvent(overrides);
  const result = press(patched, event);
  check(`${label}：维持原样（吃掉、不提交、不换行）`,
    result.returned === true && result.calls.submit.length === 0 && event.prevented === false,
    `returned=${result.returned} submit=${JSON.stringify(result.calls.submit)} prevented=${event.prevented}`);
}
{
  const event = keyEvent();
  const result = press(patched, event, { composing: true });
  check('输入法组合中的 Enter：不抢键、不提交', result.returned === true && result.calls.submit.length === 0);
}
for (const [label, overrides] of [['裸 Enter', {}], ['Ctrl+Enter', { ctrlKey: true }]]) {
  const event = keyEvent(overrides);
  const result = press(patched, event, { arbitrate: 'consumed' });
  check(`/ @ 弹窗打开时按 ${label}：仍是「确认选中项」，不提交、不换行`,
    result.returned === true && result.calls.submit.length === 0 && event.prevented === true);
}
{
  const result = press(patched, null);
  check('event === null 的既有路径未受影响（仍走 canSubmit/submit(false)）',
    result.returned === true && JSON.stringify(result.calls.submit) === '[false]', JSON.stringify(result.calls.submit));
}
//#endregion

//#region 3. 与补丁前的对照 + 设置页元数据
{
  const before = press(pristine, keyEvent());
  check('对照：补丁前裸 Enter 是提交', before.returned === true && JSON.stringify(before.calls.submit) === '[false]',
    JSON.stringify(before.calls.submit));
  const afterCtrl = press(patched, keyEvent({ ctrlKey: true }));
  const beforeCtrl = press(pristine, keyEvent({ ctrlKey: true }));
  check('对照：Ctrl+Enter 的行为补丁前后完全一致',
    JSON.stringify(afterCtrl.calls.submit) === JSON.stringify(beforeCtrl.calls.submit),
    `${JSON.stringify(afterCtrl.calls.submit)} vs ${JSON.stringify(beforeCtrl.calls.submit)}`);
  const afterShift = press(patched, keyEvent({ shiftKey: true }));
  const beforeShift = press(pristine, keyEvent({ shiftKey: true }));
  check('对照：Shift+Enter 的行为补丁前后完全一致', afterShift.returned === beforeShift.returned);
}

/** 取某一行固定快捷键条目登记的绑定元数据（只看 `bindings:` 之后，别把展示用的 describeBinding 也算进来）。 */
function bindingsOf(source, id) {
  const at = source.indexOf(id);
  const block = source.slice(at, source.indexOf('group: "input"', at));
  return [...block.slice(block.indexOf('bindings:')).matchAll(/modifiers: \[([^\]]*)\]/g)]
    .map((match) => match[1].replace(/[\s"]/g, ''));
}
const sendOld = bindingsOf(pristine, 'id: "fixed.send",');
const newlineOld = bindingsOf(pristine, 'id: "fixed.newline",');
const sendNew = bindingsOf(patched, 'id: "fixed.send",');
const newlineNew = bindingsOf(patched, 'id: "fixed.newline",');
check('「发送消息」行原有的绑定只有裸 Enter', JSON.stringify(sendOld) === '[""]', JSON.stringify(sendOld));
check('「换行」行原有绑定是 Shift+Enter', JSON.stringify(newlineOld) === '["shift"]', JSON.stringify(newlineOld));
check('「发送消息」行补丁后为 Ctrl/Cmd+Enter',
  JSON.stringify(sendNew) === '["control","meta"]', JSON.stringify(sendNew));
check('「换行」行补丁后同时登记裸 Enter 与 Shift+Enter',
  JSON.stringify(newlineNew) === '["","shift"]', JSON.stringify(newlineNew));

/** 这三行固定快捷键登记的全部绑定（冲突检测用的就是这份并集，重复项会被 Set 去重）。 */
function fixedBindingSet(source) {
  return [...new Set(['id: "fixed.send",', 'id: "fixed.newline",', 'id: "fixed.complementary",']
    .flatMap((id) => bindingsOf(source, id)))].sort();
}
check('三行固定快捷键的绑定集合与补丁前完全相同（不新增也不减少任何和弦）',
  JSON.stringify(fixedBindingSet(patched)) === JSON.stringify(fixedBindingSet(pristine)),
  `${JSON.stringify(fixedBindingSet(pristine))} vs ${JSON.stringify(fixedBindingSet(patched))}`);
// 「发送消息」与「互补行为」共用 Ctrl+Enter 是刻意的：同一个和弦在运行时按设置取互补行为。
check('「发送消息」与「互补行为」共用 Ctrl/Cmd+Enter（刻意保留，含义不同）',
  JSON.stringify(sendNew) === JSON.stringify(bindingsOf(patched, 'id: "fixed.complementary",')));

/** 取锚点行的下一行（去掉缩进）。 */
function lineAfter(source, anchor, offset) {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => line.trim() === anchor);
  return lines[index + offset].trim();
}
check('「发送消息」行展示 Ctrl（primary）绑定',
  lineAfter(patched, 'id: "fixed.send",', 2) === 'keys: scope.shortcuts.describeBinding({'
  && lineAfter(patched, 'id: "fixed.send",', 4) === 'modifiers: ["primary"]');
check('「换行」行展示键改成 Enter', lineAfter(patched, 'id: "fixed.newline",', 2) === 'keys: ["Enter"],');
check('「使用互补的 Queue／Steer 方式」那一行不动',
  lineAfter(patched, 'id: "fixed.complementary",', 4) === 'modifiers: ["primary"]');
check('设置说明（中）不再声称 Enter 提交',
  patched.includes('"智能体运行时发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为"')
  && !patched.includes('"智能体运行时 Enter 键和发送按钮的行为'));
check('设置说明（英）不再声称 Enter 提交',
  patched.includes('"What the Send button does while the agent is running; Cmd/Ctrl+Enter uses the other behavior"')
  && !patched.includes('"What Enter and the Send button do while the agent is running'));
check('撤销后设置说明逐字节还原', restored.includes('"智能体运行时 Enter 键和发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为"'));
//#endregion

report();
