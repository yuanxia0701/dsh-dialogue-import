---
name: dialogue-import
description: 把各种格式的对话文件（Chatbox 的 HTML 导出 / JSON 备份，或你手写的 .md/.txt 对话文本，含思维链）转成 DSH 原生对话会话，用「极简纯聊天」预设（无官方提示词、保留思维链），侧边栏直接显示、可续写。当用户说"导入对话 / 把这个转成会话 / 接着旧对话继续 / 手写一段对话导入"并给出文件时使用。
whenToUse: 用户给出对话文件（Chatbox 的 .html / 备份目录 / JSON，或手写的 .md/.txt 对话文本），想把它变成 DSH 原生会话。
---

# 各种格式的对话 → DSH 原生会话导入

把各种格式的对话记录（Chatbox 导出、手写 Markdown 等）转成 DSH 原生会话文件（`session.v4.jsonl.zstd`），侧边栏直接出现、可续写，不二次解析，保留思维链。

## 工具链

- 转换：`node dialogue2session.mjs <输入.html|.json|目录|.md> <会话id> [工作区路径] [预设]`
- 自检：`node validate-import.mjs <生成的 session.v4.jsonl.zstd>`

### 预设（第 4 个参数，可选，默认 `pure-chat`）

- `pure-chat` = 极简纯聊天（无官方提示词、几乎无工具）
- `pure-chat-web` = 极简纯聊天 + 联网搜索（web_search/web_fetch）
- `free-tools` = 自由工具：白名单里挂什么工具就能调什么，可自由增删（改 `cordis.patch.yml` 里 `preset-free-tools` 的 plugins 段）
- `minimal` = 官方极简 · `standard` = 标准全量 · `cordis` = 原始框架 · 或任何已注册的自定义预设 id
- 用户想指定时：`node dialogue2session.mjs 对话.md session-名 "C:\...\ai" "minimal"`

## 完整流程

1. 跑转换 → 生成 `D:\dsh-home\sessions\<工作区>\session-<id>\session.v4.jsonl.zstd`
2. 自检通过（turn/step 连续、消息 source、surfaceOp、request/header 等）
3. 用户重启 DSH → 侧边栏打开新会话 → 验证「显示 + 能续写 + 只聊天不调工具」

## 输入格式

### HTML 导出（.html）
- 每条消息 `<div class="chatbox-export-message">`，角色在 `<b>SYSTEM:/USER:/ASSISTANT:</b>` 标签里（**别用颜色判断**）
- 正文在 `<div class="break-words...">` 容器内
- SYSTEM/USER 都当用户侧；连续用户消息合并

### JSON 备份（session.json）
- 顶层 `{name, messages:[...]}`，每条 `{role, contentParts:[{type:"text"|"reasoning", text}]}`
- `reasoning` = 思维链，映射到 DSH 的 `{type:"reasoning", text}` 内容块
- `system` 角色当用户侧（人格规则）

### 手写对话文本（.md / .txt）
- 标记开头（每行一条）：`用户：` = 用户；`助手：` = AI 回复；`思维：`（或 `思考：`）= 思维链，属于紧接着的下一条 `助手：`
- 标记不区分大小写，支持别名：用户=`用户`/`user`，助手=`助手`/`ai`/`AI`/`assistant`
- 第一行 `# 标题` = 会话标题（可选）
- 无标记续行 = 追加到上一条消息；多个 `思维：` 行自动拼接
- 示例：
  ```
  # 依芙
  用户：你好
  助手：你好呀！
  用户：你是谁
  思维：用户问身份，我用依芙人设回答。
  助手：我是依芙。
  ```

## 预设（关键！）

会话必须用 `pure-chat` 预设（无官方提示词 + 仅 str_replace_editor 兜底）。注册方式：

```yaml
# 追加到 cordis.patch.yml（0.2.0-rc.2 单数 dsh-agent-preset，不是目录扫描！）
- insert:
    - id: preset-pure-chat
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: pure-chat
        name: 极简纯聊天
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: '你是用户的对话伙伴，直接回应用户的消息，不要调用工具。'
              complete: true
              includeRuntimeContext: false
          - id: filesystem
            name: cordis:group
            group: true
            isolate: { fs: true }
            config:
              - id: fs-local
                name: '@deepseek-ai/dsh-fs-local'
                config: { cwd: !!js process.env.DSH_CWD ?? process.cwd() }
              - id: str-replace-editor
                name: '@deepseek-ai/dsh-tool-str-replace-editor'
                config: { maxOutputChars: 16000 }
```

## 会话格式踩坑清单（缺一不可）

1. **header**：`{type:"session", version:4, id:"session-<uuid>", createdAt, cwd(绝对路径), isSeeded:false, delegationDepth:0, agentPreset:"pure-chat"}`
2. **事件顺序**：`permission/preset → sandbox/mode → approval/policy → agent-preset/selected → session/end-seed → model/selection`
3. **agent-preset/selected 事件必须写 `pure-chat`**（不是 header，事件才是真正生效的预设！写 cordis 会让模型拿全量工具）
4. **assistant/message**：`{turn, step, message:{role:"assistant", content:[块], source:{kind:"model", provider, model}, id}, stream:[]}` + 顶层 `surfaceOp:"append"`（`stream:[]` 空数组跳过内容回放校验）
5. **user/message**：`{content:[{type:"text",text}], source:{kind:"user", rpcId, clientTimeZone}, role:"user", id}` + `surfaceOp:"append"`
6. **agent/inbox/spliced 成对**：插入 `{target:"next-turn", start:0, inserted:[userObj]}` → turn/start → 移除 `{target:"next-turn", start:0, removedCount:1, inserted:[]}`（缺移除会"消息排队"）
7. **request/header**：`{header:{config:{provider,model,reasoningEffort,maxTokens}, adapterDefaults:{maxTokens:true}, tools:[非空清单]}, reason:"initial"}`（tools 空数组报 "must omit empty tools"，空历史报 "all deferred"）
8. **request/context**：`{provider, model, contextWindow}`
9. **turn/end**：`{turn, reason:{kind:"completed"}}`
10. **压缩**：头部单独一帧 + 事件一帧（`node:zlib` 的 `zstdCompressSync`）

## 常见报错 → 修复对照

| 报错 | 原因 | 修复 |
|---|---|---|
| Unknown agent preset | 自定义预设没注册 / 用了目录 | bundle patch 注册单数 dsh-agent-preset |
| defer_loading=false | 零工具 或 工具历史为空 | 挂 str_replace_editor + request/header 写非空 tools |
| seeded Session lacks inherited end-seed marker | isSeeded:true | 改 false |
| requires a producer-owned source kind | assistant 缺 source | 补 {kind:"model"} |
| requires a surfaceOp marker | 缺 surfaceOp | 补 "append" |
| must omit empty tools | tools:[] | 删空数组 |
| invalid settlement fields | assistant 缺 stream | 补 stream:[] |
| N 条消息排队 | 缺移除 splice | 补 removedCount splice |

## 验证要点

- 会话能打开、用户+AI 气泡完整显示
- 能直接续写（不报 defer_loading / Unknown preset / 排队）
- 模型**只聊天、不读文件不读工具**（这才是"极简"）
- 思维链（reasoning）正确显示
