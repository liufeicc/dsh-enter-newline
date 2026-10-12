English | [中文](README.zh-CN.md)

# dsh-enter-newline

**Enter inserts a newline, Ctrl/Cmd+Enter submits**

## 1. What Problem Does This Solve

DSH's composer uses "Enter submits, Shift+Enter inserts a newline" by default.
But people who write multi-line prompts are used to the opposite: **Enter means a newline**, and you press **Ctrl+Enter** to send.
This patch swaps the two:

| Key | Default | After patching |
|---|---|---|
| `Enter` | submits | **inserts a newline** |
| `Shift+Enter` | inserts a newline | inserts a newline (unchanged, no need to retrain muscle memory) |
| `Ctrl`/`Cmd`+`Enter` | follows the complementary behavior of `busyEnter` | unchanged |
| Composer empty, with queued messages waiting to be steered | `Ctrl+Enter` = steer-send all queued messages | unchanged |
| `Enter` while a `/` or `@` popup is open | confirms the selected item | unchanged |
| `Enter` during IME composition | handed to the IME | unchanged |
| `Alt+Enter`, `Ctrl+Meta+Enter`, `AltGraph` | swallowed | unchanged |

**It answers exactly one question: whether Enter submits. Nothing else is touched.**
The semantics of `Ctrl+Enter` are not changed by a single byte, so while the agent is running it is still the "complementary" behavior —
i.e. under the default settings it **steers** instead of queueing; **queued sending is still handled by the Send button**.

## 2. What Changed

The target file is the compiled artifact that dsh actually loads (not the source repository):

```
<dsh-install>/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js
```

(For a global install, `<dsh-install>` is typically `$(npm root -g)/@deepseek-ai/dsh`.)
The absolute path as actually resolved can be inspected with
`readlink -f ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`.

There are 5 edits in total, all anchored on uniquely identifiable code snippets (if an anchor does not match exactly one site, the script errors out and exits):

| # | Location | Change |
|---|---|---|
| 1 | In the composer's `KEY_ENTER_COMMAND` handler, before the unconditional `preventDefault()` | **A one-line guard is inserted**: for a real keyboard event without Ctrl/Cmd, `return false`, handing Enter back to the editor's default handling → inserts a newline |
| 2 | Settings → Shortcuts, the "Send message" row | The displayed keys and the binding metadata change from bare `Enter` to `Ctrl/Cmd+Enter` |
| 3 | Settings → Shortcuts, the "Newline" row | The displayed key becomes `Enter`, and the binding metadata gains bare `Enter` (Shift+Enter is still registered) |
| 4 | Settings → General, the Chinese description of "Send behavior while busy" | "the behavior of the Enter key and the Send button…" → "the behavior of the Send button…" |
| 5 | Same as above, the English description | kept in sync |

The patch text carries the `LOCAL-PATCH:enter-newline` marker, which the script uses to stay idempotent.

### Why a single `return false` amounts to "insert a newline"

Inserting a newline requires no new logic at all — only **not intercepting** this key. The chain already exists:

1. The editor's key listener (the `@lexical/plain-text` `onKeyDown` in the same file) dispatches `KEY_ENTER_COMMAND` when Enter is pressed;
2. The handler registered by the composer (priority 4, the highest) decides whether to swallow it. In the original code it **unconditionally** calls `preventDefault()` and submits;
3. Once the handler does `return false`, Lexical's default listener takes over: `KEY_ENTER_COMMAND → INSERT_LINE_BREAK_COMMAND → selection.insertLineBreak(false)`, inserting the newline into the draft.

Step 3 is exactly **the path Shift+Enter takes today** — so it is bound to be fine, and we never need to touch the editor's internal state.

### Why not write it as a plugin

The composer's editor and keymap are shell-private objects; all the plugin layer can reach is a single `arbitrate` voting hook ("do I swallow this key?"). And once it has swallowed the key:

- nothing happens (a swallowed key has no default behavior);
- trying to make up for it with `document.execCommand("insertLineBreak")` lands in Lexical's `beforeinput` handling,
  whose treatment of `insertLineBreak` is to **dispatch `KEY_ENTER_COMMAND` once more** — very likely looping back to "submit".

In other words: the plugin layer has no "insert a newline" path. Patching the compiled artifact is the only reliable approach,
and the accompanying script is responsible for "replayable after an upgrade" and "fail loudly instead of patching the wrong place".

## 3. How to Use

```bash
cd /path/to/dsh-enter-newline

node patch.mjs            # apply the patch (skipped if already applied); the target file is resolved from the profile automatically
node patch.mjs --check    # status only
node patch.mjs --revert   # revert (strictly the inverse of applying, and independent of the backup file)
node patch.mjs --target /path/to/other/install/lib/client.js   # point at a different installation
node test/patch-contract.mjs   # contract tests (51 assertions)
```

- Before patching, an original copy is kept as `client.js.orig-enter-newline` (the filename does not end in `.js`,
  so the client's chunk scanning rules will not pick it up).
- Before writing, the artifact is given an ESM syntax check by Node itself (copied to `.mjs` and run through `node --check`);
  if it fails, **nothing is written**: a broken patch is worse than no patch.
- **No restart is needed** after patching: `dsh-client-hmr` polls the client bundle every 500ms,
  and once mtime/ctime/size change it recomputes the rev and pushes it to the browser over SSE for hot reload. Refreshing the page once is the safest bet.

## 4. After a dsh Upgrade

Upgrading `dsh` overwrites `node_modules`, so the patch is lost (back to "Enter submits"). Just run it again:

```bash
node patch.mjs
```

If the upgrade also rewrote this code, the script **errors out instead of blindly patching**, for example:

```
锚点「composer 的 KEY_ENTER_COMMAND 处理器」匹配到 0 处，期望恰好 1 处；DSH 可能已升级并改写了这段代码，请重新核对补丁
```

(That is: the anchor "the composer's `KEY_ENTER_COMMAND` handler" matched 0 sites, expected exactly 1; DSH may have been upgraded and rewritten this code — please re-check the patch.)

At that point you need to re-check the anchors against the new `client.js` and then update the constants in `lib/patch-core.mjs`.
You can run `node patch.mjs --check` first to confirm the state.

## 5. How to Verify the Patch Really Took Effect

1. **Offline contract tests** (51 assertions were run this time, all passing):

   ```bash
   node test/patch-contract.mjs
   ```

   It does three things: ① all five anchors are unique, applying/reverting are byte-for-byte inverses, and applying twice errors out;
   ② it **extracts the patched `KEY_ENTER_COMMAND` handler verbatim and executes it as a function**,
   driving every branch in the table above with fake events (this tests the code the browser will actually execute, rather than a re-implementation validating itself);
   ③ the settings-page metadata and copy, including the invariant that "the binding set of the three fixed shortcut rows is unchanged".

2. **Look at the bundle the server actually serves** (the `/plugins/events` SSE endpoint needs no authentication
   and pushes the full client module graph):

   ```bash
   # replace 44555 with your own DSH Web GUI port
   timeout 5 curl -s -N http://127.0.0.1:44555/plugins/events > /tmp/sse.txt
   # take the graph from the first data: line, find the rev and url of @deepseek-ai/dsh-client-ui-conversation,
   # then fetch that url (note --path-as-is, since the path contains a literal @)
   curl -sg --path-as-is "http://127.0.0.1:44555/plugins/??@deepseek-ai/dsh-client-ui-conversation/client.js&rev=<rev>" \
     | grep -c "LOCAL-PATCH:enter-newline"     # expect 1
   ```

   If that package's `rev` in the graph has changed and the fetched bundle contains the marker,
   then what the server sends out is the patched code (example verification: rev `3f63da74640b`, 716629 bytes, 1 hit).

3. **Press it by hand once**: in the composer, `Enter` should insert a newline without sending, and `Ctrl+Enter` should send.

## 6. Known Trade-offs

- **Holding `Enter` inserts newlines continuously.** Handing the key to the editor means inheriting the editor's standard behavior;
  going back to "holding counts as one press" would require intercepting `event.repeat` again, at the cost of a strange feel while the key is held, so it is not intercepted.
- **At runtime, "queue send" can only be triggered by clicking the Send button.** Because the semantics of `Ctrl+Enter` are deliberately left unchanged,
  at runtime it is the complementary behavior (under the default settings = steer). If you ever want `Ctrl+Enter` to
  fully take over from Enter (i.e. also queue according to `busyEnter` at runtime), change the line
  `handlers.submit(event?.ctrlKey === true || event?.metaKey === true)`
  to `handlers.submit(false)` — the cost being that "steer-send all queued messages" loses its keyboard entry point.
- **Settings → Shortcuts shows two rows displaying `Ctrl+Enter`**: "Send message" and
  "Use the complementary Queue/Steer behavior". These are two meanings of the same chord (the latter only takes effect at runtime),
  and both rows hold, so both are kept; the **binding set registered by the three fixed shortcut rows is exactly the same as before the change** — no chord is added or removed.
- **Only the main composer is changed.** Text boxes in the settings page, the goal editor, and the user-question box all have their own Enter logic and are unaffected.
- The patch is applied to **the compiled artifact**, i.e. it "edits node_modules"; for the reasoning see "Why not write it as a plugin" above.

## License

This project is released under the MIT License. See [LICENSE](LICENSE) for details.
