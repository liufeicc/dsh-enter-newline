[English](README.md) | 中文

# dsh-enter-newline

**Enter 插入换行，Ctrl/Cmd+Enter 提交**

## 一、解决什么问题

DSH 输入框的默认键位是「Enter 提交、Shift+Enter 换行」。
但写多行提示词的人更习惯反过来：**Enter 就是换行**，要发才按 **Ctrl+Enter**。
本补丁把这个键位换过来：

| 按键 | 默认 | 打补丁后 |
|---|---|---|
| `Enter` | 提交 | **插入换行** |
| `Shift+Enter` | 插入换行 | 插入换行（不变，肌肉记忆不用改） |
| `Ctrl`/`Cmd`+`Enter` | 按 `busyEnter` 的互补方式 | 不变 |
| 输入框为空、且有待插话的排队消息 | `Ctrl+Enter` = 插话发送全部排队 | 不变 |
| `/` 或 `@` 弹窗打开时的 `Enter` | 确认选中项 | 不变 |
| 输入法组合中的 `Enter` | 交给输入法 | 不变 |
| `Alt+Enter`、`Ctrl+Meta+Enter`、`AltGraph` | 吃掉 | 不变 |

**只回答一个问题：本次改动改变了「Enter 是否提交」，其它一律不动。**
`Ctrl+Enter` 的语义一个字节都没改，所以智能体运行时它依然是「互补方式」——
即默认设置下会**插话**而不是排队；**排队发送仍然由发送按钮承担**。

## 二、改了什么

目标文件是 dsh 实际加载的编译产物（不是源码仓库）：

```
<dsh-install>/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js
```

（全局安装时，`<dsh-install>` 通常就是 `$(npm root -g)/@deepseek-ai/dsh`。）
实际解析出来的绝对路径可以用
`readlink -f ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 查看。

一共 5 处改动，全部锚定在唯一可识别的代码片段上（锚点匹配数不是 1 就报错退出）：

| # | 位置 | 改动 |
|---|---|---|
| 1 | composer 的 `KEY_ENTER_COMMAND` 处理器里，无条件 `preventDefault()` 之前 | **插入一行守卫**：真实键盘事件且没按 Ctrl/Cmd 时 `return false`，把 Enter 交回编辑器默认处理 → 插入换行 |
| 2 | 设置 → 快捷键「发送消息」行 | 展示键与绑定元数据由裸 `Enter` 改为 `Ctrl/Cmd+Enter` |
| 3 | 设置 → 快捷键「换行」行 | 展示键改为 `Enter`，绑定元数据补上裸 `Enter`（Shift+Enter 仍登记） |
| 4 | 设置 → 通用「繁忙时的发送行为」中文说明 | 「Enter 键和发送按钮的行为…」→「发送按钮的行为…」 |
| 5 | 同上，英文说明 | 同步 |

补丁文本里带 `LOCAL-PATCH:enter-newline` 标记，脚本靠它判断幂等。

### 为什么一行 `return false` 就等于「插入换行」

「插入换行」不需要写任何新逻辑，只需要**不拦**这个键。链路是现成的：

1. 编辑器的键盘监听（同文件里那份 `@lexical/plain-text` 的 `onKeyDown`）在按下 Enter 时派发 `KEY_ENTER_COMMAND`；
2. composer 注册的处理器（优先级 4，最高）决定要不要吃掉它。原文在这里**无条件** `preventDefault()` 并提交；
3. 处理器 `return false` 之后，Lexical 的默认监听接手：`KEY_ENTER_COMMAND → INSERT_LINE_BREAK_COMMAND → selection.insertLineBreak(false)`，把换行插进草稿。

第 3 步就是**今天 Shift+Enter 走的那条路**——所以它一定是好的，不需要碰编辑器的内部状态。

### 为什么不写成一个插件

输入框的编辑器和键位表都是 shell 私有对象，插件层能碰到的只有一个 `arbitrate` 投票口（「这个键我吃不吃」）。吃掉之后：

- 什么都不会发生（吃掉了就没有默认行为）；
- 想靠 `document.execCommand("insertLineBreak")` 补一个换行，会走进 Lexical 的 `beforeinput` 处理，
  而它对 `insertLineBreak` 的处理是**再派发一次 `KEY_ENTER_COMMAND`**，极可能绕回「提交」。

也就是说：插件层没有「插入换行」这条通路。改编译产物是唯一稳妥的做法，
配套的脚本负责「升级后可重放」和「改错就报错」。

## 三、怎么用

```bash
cd /path/to/dsh-enter-newline

node patch.mjs            # 打补丁（已打过会跳过）；自动从 profile 定位目标文件
node patch.mjs --check    # 只看状态
node patch.mjs --revert   # 撤销（与打补丁严格互逆，不依赖备份文件）
node patch.mjs --target /path/to/other/install/lib/client.js   # 指定其它安装位置
node test/patch-contract.mjs   # 契约测试（51 条断言）
```

- 打补丁前会留一份原始副本 `client.js.orig-enter-newline`（文件名不以 `.js` 结尾，
  不会被客户端的 chunk 扫描规则命中）。
- 写入前会拿 Node 自己给产物做一次 ESM 语法检查（复制成 `.mjs` 再 `node --check`），
  不通过就**不写**：改坏了不如不改。
- 改完**不需要重启**：`dsh-client-hmr` 每 500ms 轮询一次客户端 bundle，
  mtime/ctime/size 变了就重算 rev 并通过 SSE 推给浏览器热加载。刷新一次页面最稳妥。

## 四、dsh 升级之后

`dsh` 升级会覆盖 `node_modules`，补丁随之丢失（回到「Enter 提交」）。重新跑一次：

```bash
node patch.mjs
```

如果升级同时改写了这段代码，脚本会**报错退出而不是瞎改**，例如：

```
锚点「composer 的 KEY_ENTER_COMMAND 处理器」匹配到 0 处，期望恰好 1 处；DSH 可能已升级并改写了这段代码，请重新核对补丁
```

这时需要照着新版 `client.js` 重新核对锚点，再更新 `lib/patch-core.mjs` 里的常量。
可以先 `node patch.mjs --check` 确认状态。

## 五、怎么验证补丁真的生效

1. **离线契约测试**（本次跑了 51 条，全过）：

   ```bash
   node test/patch-contract.mjs
   ```

   它做三件事：①五个锚点唯一、打补丁/撤销逐字节互逆、重复打补丁报错；
   ②把补丁后产物里那段 `KEY_ENTER_COMMAND` 处理器**原样抠出来当函数执行**，
   用假事件跑完上表所有分支（测的是真正会被浏览器执行的代码，而不是复刻一份逻辑自我验证）；
   ③设置页元数据与文案，含「三行固定快捷键的绑定集合不变」这个不变量。

2. **看服务器实际发出去的 bundle**（`/plugins/events` 这个 SSE 端点不需要鉴权，
   会推送完整的客户端模块图谱）：

   ```bash
   # 把 44555 换成你自己的 DSH Web GUI 端口
   timeout 5 curl -s -N http://127.0.0.1:44555/plugins/events > /tmp/sse.txt
   # 取第一条 data: 行里的 graph，找到 @deepseek-ai/dsh-client-ui-conversation 的 rev 与 url，
   # 再抓那个 url（注意用 --path-as-is，路径里有字面量 @）
   curl -sg --path-as-is "http://127.0.0.1:44555/plugins/??@deepseek-ai/dsh-client-ui-conversation/client.js&rev=<rev>" \
     | grep -c "LOCAL-PATCH:enter-newline"     # 期望 1
   ```

   图谱里该包的 `rev` 变过、且抓下来的 bundle 里能搜到标记，
   就说明服务器发出去的就是打补丁后的代码（验收示例：rev `3f63da74640b`，716629 字节，命中 1 次）。

3. **肉手按一次**：在输入框里按 `Enter` 应当换行不发送，按 `Ctrl+Enter` 应当发送。

## 六、已知取舍

- **长按 `Enter` 会连续插入换行**。放行给编辑器就意味着沿用编辑器的标准行为；
  要退回「按住只算一次」得再拦一遍 `event.repeat`，代价是按住不放时手感变奇怪，所以不拦。
- **运行时想「排队发送」只能点发送按钮**。因为 `Ctrl+Enter` 的语义刻意保持不变，
  它在运行时是互补方式（默认设置下 = 插话）。若哪天想让 `Ctrl+Enter` 完全顶替 Enter
  （运行时也按 `busyEnter` 排队），把那行 `handlers.submit(event?.ctrlKey === true || event?.metaKey === true)`
  改成 `handlers.submit(false)` 即可 —— 代价是「插话发送全部排队消息」失去键盘入口。
- **设置 → 快捷键里有两行显示 `Ctrl+Enter`**：「发送消息」与
  「使用互补的 Queue／Steer 方式」。这是同一个和弦的两个含义（后者只在运行时生效），
  两行都成立，所以都留着；三行固定快捷键登记的**绑定集合与改动前完全相同**，不新增也不减少任何和弦。
- **只改主输入框（composer）**。设置页里的文本框、目标编辑框、用户提问框都有自己的回车逻辑，不受影响。
- 补丁打在**编译产物**上，属于「改 node_modules」；理由见上面「为什么不写成一个插件」。

## 许可证

本项目采用 MIT 协议，详见 [LICENSE](LICENSE)。
