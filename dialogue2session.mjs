// 对话文件 → DSH 原生会话文件 (session.v4.jsonl.zstd)
// 支持: HTML 导出(.html)、JSON 备份(session.json / 含 session.json 的目录)、手写对话(.md/.txt)
// 用法: node dialogue2session.mjs <输入> [会话id] [工作区cwd] [预设]
//   预设 = 任意已注册的 agent preset 名（默认 pure-chat）：
//     pure-chat（极简纯聊天）· minimal（极简）· standard（标准）· cordis · shiguang-lite（拾光）等
//
// 环境变量:
//   DSH_HOME —— DSH home 目录（默认 D:\dsh-home；用其它 home 时务必设置）
import fs from 'node:fs'
import z from 'node:zlib'
import { randomUUID } from 'node:crypto'

const [input, givenId, cwdArg, presetArg] = process.argv.slice(2)
if (!input) { console.error('用法: node dialogue2session.mjs <输入.html|.json|目录|.md> [会话id] [工作区cwd] [预设]'); process.exit(1) }

const DSH_HOME = process.env.DSH_HOME || 'D:\\dsh-home'
const CWD = cwdArg || 'C:\\Users\\yuan\\Desktop\\ai'   // 会话所属工作区（侧边栏分组）
const AGENT_PRESET = presetArg || 'pure-chat'   // 可选：导入成哪种预设模式

// 工作区目录编码: C:\Users\yuan\Desktop\ai -> --C-Users-yuan-Desktop-ai--
// 冒号删除、反斜杠变横杠；非 ASCII 字符编码为 ~XXXX~（如"创作" -> ~521B~4F5C~）
function encodeWorkspace(cwd) {
  return '--' + [...cwd].map((ch) => {
    if (ch === '\\') return '-'
    if (ch === ':') return ''
    const code = ch.codePointAt(0)
    if (code < 128) return ch
    return '~' + code.toString(16).toUpperCase().padStart(4, '0') + '~'
  }).join('') + '--'
}

// ---- 工具：HTML 实体解码 ----
function decode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
}

// ---- 1a. 解析 HTML 导出 → msgs [{role, blocks:[{type,text}]}] ----
function parseHtml(html) {
  const parts = html.split('<div class="chatbox-export-message')
  const msgs = []
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
    // 角色从 <b>LABEL</b> 读（SYSTEM/USER/ASSISTANT），颜色只做兜底
    const bm = p.match(/<b>([^<]*)<\/b>/)
    const label = (bm ? bm[1] : '').trim().replace(/:\s*$/, '')
    let role = null
    if (/^system$/i.test(label)) role = 'user'
    else if (/^assistant$/i.test(label)) role = 'assistant'
    else if (/^user$/i.test(label)) role = 'user'
    else {
      if (p.includes('text-green-500')) role = 'user'
      else if (p.includes('text-blue-500')) role = 'assistant'
    }
    if (!role) continue
    const cm = p.match(/<div class="break-words[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)
    if (!cm) continue
    let text = cm[1]
    text = text.replace(/<br\s*\/?>/gi, '\n')
    text = text.replace(/<[^>]+>/g, '')
    text = decode(text).trim()
    if (text) msgs.push({ role, blocks: [{ type: 'text', text }] })
  }
  return { msgs, title: null }
}

// ---- 1b. 解析 JSON 备份 → msgs [{role, blocks:[{type,text}]}] ----
function parseJson(obj) {
  const msgs = []
  for (const m of obj.messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'  // system + user → user
    const blocks = []
    for (const p of m.contentParts || []) {
      if (p.type === 'text' || p.type === 'reasoning') {
        const text = (p.text || '').trim()
        if (text) blocks.push({ type: p.type, text })
      }
    }
    if (blocks.length) msgs.push({ role, blocks })
  }
  return { msgs, title: typeof obj.name === 'string' && obj.name ? obj.name : null }
}

// ---- 1c. 解析手写对话文本（.md/.txt，可写用户/助手/思维链）----
// 格式（每行一条，冒号标记开头）：
//   # 可选标题（仅第一行 # 开头）
//   用户：<内容>
//   助手：<内容>
//   思维：<思维链>     ← 属于紧接着的下一条"助手"（可连续多行"思维"拼接）
//   无标记的续行 = 追加到上一条消息
// 示例：
//   # 我的对话
//   用户：你好
//   助手：你好呀！
//   用户：你是谁
//   思维：用户问身份，我用依芙的人设回答。
//   助手：我是依芙。
function parseText(text) {
  const msgs = []
  let title = null
  let pendingReasoning = null
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '')
    if (i === 0 && line.startsWith('#')) { title = line.replace(/^#+\s*/, '').trim(); continue }
    const m = line.match(/^(用户|user|助手|ai|assistant|思维|思考)[：:]\s*(.*)$/i)
    if (m) {
      const kind = m[1].toLowerCase()
      const content = m[2].trim()
      if (kind === '用户' || kind === 'user') {
        msgs.push({ role: 'user', blocks: content ? [{ type: 'text', text: content }] : [] })
      } else if (kind === '助手' || kind === 'ai' || kind === 'assistant') {
        const blocks = []
        if (pendingReasoning) { blocks.push({ type: 'reasoning', text: pendingReasoning }); pendingReasoning = null }
        if (content) blocks.push({ type: 'text', text: content })
        msgs.push({ role: 'assistant', blocks })
      } else { // 思维 / 思考
        if (content) pendingReasoning = (pendingReasoning ? pendingReasoning + '\n' : '') + content
      }
    } else if (line.trim()) {
      const last = msgs[msgs.length - 1]
      if (last && last.blocks.length) {
        last.blocks[last.blocks.length - 1].text += '\n' + line.trim()
      }
    }
  }
  return { msgs, title }
}

// ---- 1d. 定位并读取输入 ----
function findSessionJson(dir) {
  try {
    const direct = `${dir}/session.json`
    if (fs.existsSync(direct)) return direct
  } catch {}
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = `${d}/${name}`
      if (fs.statSync(p).isDirectory()) {
        if (fs.existsSync(`${p}/session.json`)) return `${p}/session.json`
        const r = walk(p)
        if (r) return r
      }
    }
    return null
  }
  return walk(dir)
}

let parsed
const st = fs.statSync(input)
if (st.isDirectory()) {
  const jp = findSessionJson(input)
  if (!jp) { console.error('目录里没找到 session.json'); process.exit(1) }
  parsed = parseJson(JSON.parse(fs.readFileSync(jp, 'utf8')))
} else if (input.toLowerCase().endsWith('.json')) {
  parsed = parseJson(JSON.parse(fs.readFileSync(input, 'utf8')))
} else if (/\.(md|txt|markdown)$/i.test(input)) {
  parsed = parseText(fs.readFileSync(input, 'utf8'))
} else {
  parsed = parseHtml(fs.readFileSync(input, 'utf8'))
}
const { msgs, title: presetTitle } = parsed
if (!msgs.length) { console.error('没解析到消息'); process.exit(1) }

// ---- 2. 构造会话事件 ----
const now = Date.now()
const sessionId = givenId || 'session-' + randomUUID()
const header = JSON.stringify({
  type: 'session', version: 4, id: sessionId, createdAt: now,
  cwd: CWD, isSeeded: false, delegationDepth: 0, agentPreset: AGENT_PRESET,
})

let seq = 0
const ev = (type, data, extra) => { const o = { type, seq: seq++, time: now, data }; if (extra) Object.assign(o, extra); return o }
const events = []
events.push(ev('permission/preset', { preset: 'workspace-write' }))
events.push(ev('sandbox/mode', { mode: 'workspace-write' }))
events.push(ev('approval/policy', { policy: 'never' }))
events.push(ev('agent-preset/selected', { agentPreset: AGENT_PRESET }))   // 事件才是真正生效的预设
events.push(ev('session/end-seed', {}))
events.push(ev('model/selection', { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }))

// request/header 的历史工具清单：非空即可（空历史会导致"all deferred"）
const TOOLS = [
  { name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'write', description: 'Create or fully replace a UTF-8 text file.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
]

let turn = 0
let firstUserSeq = null
let i = 0
while (i < msgs.length) {
  // 合并连续的用户/系统消息为一个回合的用户侧
  const userMsgs = []
  while (i < msgs.length && msgs[i].role === 'user') { userMsgs.push(msgs[i]); i++ }
  if (userMsgs.length === 0) { i++; continue }
  const asstMsgs = []
  while (i < msgs.length && msgs[i].role === 'assistant') { asstMsgs.push(msgs[i]); i++ }
  const userText = userMsgs.flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text)).join('\n\n')
  const assistantBlocks = asstMsgs.flatMap((m) => m.blocks)  // 含 reasoning + text
  if (!userText || assistantBlocks.length === 0) continue  // 孤立消息跳过
  turn++

  const userObj = {
    content: [{ type: 'text', text: userText }],
    source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Asia/Shanghai' },
    role: 'user', id: randomUUID(),
  }
  events.push(ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [userObj] }))
  events.push(ev('turn/start', { turn }))
  events.push(ev('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }))
  events.push(ev('step/start', { turn, step: 1 }))
  if (turn === 1) {
    events.push(ev('system/message', { turn, step: 1, message: { id: 'sys-' + randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [] } }, { surfaceOp: 'append' }))
  }
  events.push(ev('user/message', userObj, { surfaceOp: 'append' }))
  if (firstUserSeq === null) {
    firstUserSeq = seq - 1
    const title = presetTitle || userText.slice(0, 60)
    events.push(ev('session/title', { title, messageSeqs: [firstUserSeq], source: { kind: 'fallback' } }))
  }
  events.push(ev('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 256000 }, adapterDefaults: { maxTokens: true }, tools: TOOLS }, reason: 'initial' }))
  events.push(ev('request/context', { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1000000 }))
  events.push(ev('assistant/message', { turn, step: 1, message: { role: 'assistant', content: assistantBlocks, source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }, id: randomUUID() }, stream: [] }, { surfaceOp: 'append' }))
  events.push(ev('step/end', { turn, step: 1 }))
  events.push(ev('turn/end', { turn, reason: { kind: 'completed' } }))
}

// ---- 3. 压缩并写文件（头部独立帧 + 事件一帧）----
const headerFrame = z.zstdCompressSync(Buffer.from(header + '\n', 'utf8'))
const eventsText = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
const eventsFrame = z.zstdCompressSync(Buffer.from(eventsText, 'utf8'))
const out = Buffer.concat([headerFrame, eventsFrame])

const wsDir = encodeWorkspace(CWD)
const sessionDir = `${DSH_HOME.replace(/[\\/]$/, '')}/sessions/${wsDir}/${sessionId}`
fs.mkdirSync(sessionDir, { recursive: true })
fs.writeFileSync(`${sessionDir}/session.v4.jsonl.zstd`, out)
console.log(`✅ 写入 ${sessionDir}/session.v4.jsonl.zstd`)
console.log(`   ${msgs.length} 条消息, ${turn} 回合, ${seq} 事件, ${out.length} 字节`)
