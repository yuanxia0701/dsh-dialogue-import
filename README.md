# @deepseek-ai/dsh-dialogue-import

把**各种格式的对话文件**（Chatbox 的 HTML 导出、JSON 备份，或手写 Markdown）转成 **DeepSeek Harness 原生会话**，保留思维链，配套「极简纯聊天」系列预设。

## 提供什么

### 1. 工具 `import_dialogue`

AI 原生调用，说一句"把 xxx 导入成联网模式"即可，不用手动跑脚本。

| 参数 | 说明 |
|---|---|
| `path`（必填） | 输入文件：`.html` / `.json` / 含 `session.json` 的目录 / `.md`/`.txt` 手写对话 |
| `session_id` | 会话 id（默认随机） |
| `preset` | 预设 id：`pure-chat`（默认）/ `pure-chat-web` / `free-tools` |
| `workspace` | 工作区路径（默认当前会话 cwd） |

### 2. 三个极简预设（见 `presets.yml`，YAML 声明）

| 预设 | 说明 |
|---|---|
| `pure-chat` | 极简纯聊天：无官方提示词、仅 tool-fs |
| `pure-chat-web` | 极简纯聊天 + 联网搜索（web_search/web_fetch） |
| `free-tools` | 自由工具白名单：默认纯聊天，白名单里挂什么调什么 |

> **重要**：预设必须用**单数** `@deepseek-ai/dsh-agent-preset`（EntryGroup）声明，不能由普通插件 `register` 注册——否则全局工具会泄漏进预设。

## 支持的手写格式（.md/.txt）

```
# 可选标题
用户：你好
助手：你好呀！
用户：你是谁
思维：用户问身份，我用依芙人设回答。
助手：我是依芙。
```

标记不区分大小写，别名：用户=`用户`/`user`，助手=`助手`/`ai`/`AI`/`assistant`，思维链=`思维`/`思考`。

## 安装

### 第 1 步：装插件（`import_dialogue` 工具）

把本包复制到 `profiles/desktop/node_modules/@deepseek-ai/dsh-dialogue-import/`，并在 `cordis.patch.yml` 加：

```yaml
- insert:
    - id: dialogue-import
      name: '@deepseek-ai/dsh-dialogue-import'
```

### 第 2 步：装预设

把 `presets.yml` 的内容追加到 `cordis.patch.yml`。

### 第 3 步：重启 DSH

## 使用

### 方式 A：AI 直接调工具

在 DSH 里说：「把 `C:\...\依芙` 导入成联网模式」，AI 会调 `import_dialogue`。

### 方式 B：命令行脚本（`dialogue2session.mjs`）

```bash
node dialogue2session.mjs <输入> <会话id> [工作区] [预设]
```

## 技术要点（踩坑）

- 会话格式 v4：`sessions\<工作区编码>\session-<id>\session.v4.jsonl.zstd`，zstd = `node:zlib` 内置
- 会话里真正生效的预设是 `agent-preset/selected` 事件（不是 header）
- DeepSeek 模型必须至少 1 个非延迟工具（`defer_loading` 报错），用 tool-fs 兜底
- `request/header` 要写非空 `tools`（空历史会"全延迟"）
- 助手消息需 `source:{kind:"model"}` + `surfaceOp:"append"` + `stream:[]`

## License

MIT
