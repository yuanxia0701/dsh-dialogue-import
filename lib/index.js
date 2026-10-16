// @deepseek-ai/dsh-dialogue-import — host 半边
// 1) 注册 import_dialogue 工具：把对话文件转成 DSH 原生会话（session.v4.jsonl.zstd），保留思维链
// 2) 注册极简纯聊天系列预设：pure-chat / pure-chat-web / free-tools
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { zstdCompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'

const name = 'dialogue-import'
const inject = ['tools']

const Config = z.object({})

// ════════════ 转换逻辑（从 dialogue2session.mjs 移植）════════════

function decodeHtml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
}

function parseHtml(html) {
  const parts = html.split('<div class="chatbox-export-message')
  const msgs = []
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
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
    text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    text = decodeHtml(text).trim()
    if (text) msgs.push({ role, blocks: [{ type: 'text', text }] })
  }
  return { msgs, title: null }
}

function parseJson(obj) {
  const msgs = []
  for (const m of obj.messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
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
      } else {
        if (content) pendingReasoning = (pendingReasoning ? pendingReasoning + '\n' : '') + content
      }
    } else if (line.trim()) {
      const last = msgs[msgs.length - 1]
      if (last && last.blocks.length) last.blocks[last.blocks.length - 1].text += '\n' + line.trim()
    }
  }
  return { msgs, title }
}

function findSessionJson(dir) {
  const direct = `${dir}/session.json`
  if (existsSync(direct)) return direct
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = `${d}/${name}`
      if (statSync(p).isDirectory()) {
        if (existsSync(`${p}/session.json`)) return `${p}/session.json`
        const r = walk(p)
        if (r) return r
      }
    }
    return null
  }
  return walk(dir)
}

function loadInput(input) {
  const st = statSync(input)
  if (st.isDirectory()) {
    const jp = findSessionJson(input)
    if (!jp) throw new Error('目录里没找到 session.json')
    return parseJson(JSON.parse(readFileSync(jp, 'utf8')))
  }
  if (input.toLowerCase().endsWith('.json')) return parseJson(JSON.parse(readFileSync(input, 'utf8')))
  if (/\.(md|txt|markdown)$/i.test(input)) return parseText(readFileSync(input, 'utf8'))
  return parseHtml(readFileSync(input, 'utf8'))
}

function encodeWorkspace(cwd) {
  return '--' + [...cwd].map((ch) => {
    if (ch === '\\') return '-'
    if (ch === ':') return ''
    const code = ch.codePointAt(0)
    if (code < 128) return ch
    return '~' + code.toString(16).toUpperCase().padStart(4, '0') + '~'
  }).join('') + '--'
}

const TOOLS = [
  { name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'write', description: 'Create or fully replace a UTF-8 text file.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
]

function buildSession(msgs, title, { cwd, preset, sessionId, dshHome }) {
  const now = Date.now()
  const header = JSON.stringify({
    type: 'session', version: 4, id: sessionId, createdAt: now,
    cwd, isSeeded: false, delegationDepth: 0, agentPreset: preset,
  })
  let seq = 0
  const ev = (type, data, extra) => { const o = { type, seq: seq++, time: now, data }; if (extra) Object.assign(o, extra); return o }
  const events = []
  events.push(ev('permission/preset', { preset: 'workspace-write' }))
  events.push(ev('sandbox/mode', { mode: 'workspace-write' }))
  events.push(ev('approval/policy', { policy: 'never' }))
  events.push(ev('agent-preset/selected', { agentPreset: preset }))
  events.push(ev('session/end-seed', {}))
  events.push(ev('model/selection', { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }))

  let turn = 0
  let i = 0
  while (i < msgs.length) {
    const userMsgs = []
    while (i < msgs.length && msgs[i].role === 'user') { userMsgs.push(msgs[i]); i++ }
    if (userMsgs.length === 0) { i++; continue }
    const asstMsgs = []
    while (i < msgs.length && msgs[i].role === 'assistant') { asstMsgs.push(msgs[i]); i++ }
    const userText = userMsgs.flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text)).join('\n\n')
    const assistantBlocks = asstMsgs.flatMap((m) => m.blocks)
    if (!userText || assistantBlocks.length === 0) continue
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
    if (turn === 1) {
      const t = title || userText.slice(0, 60)
      events.push(ev('session/title', { title: t, messageSeqs: [seq - 1], source: { kind: 'fallback' } }))
    }
    events.push(ev('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 256000 }, adapterDefaults: { maxTokens: true }, tools: TOOLS }, reason: 'initial' }))
    events.push(ev('request/context', { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1000000 }))
    events.push(ev('assistant/message', { turn, step: 1, message: { role: 'assistant', content: assistantBlocks, source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }, id: randomUUID() }, stream: [] }, { surfaceOp: 'append' }))
    events.push(ev('step/end', { turn, step: 1 }))
    events.push(ev('turn/end', { turn, reason: { kind: 'completed' } }))
  }

  const headerFrame = zstdCompressSync(Buffer.from(header + '\n', 'utf8'))
  const eventsText = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const eventsFrame = zstdCompressSync(Buffer.from(eventsText, 'utf8'))
  const out = Buffer.concat([headerFrame, eventsFrame])

  const wsDir = encodeWorkspace(cwd)
  const sessionDir = `${dshHome.replace(/[\\/]$/, '')}/sessions/${wsDir}/${sessionId}`
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(`${sessionDir}/session.v4.jsonl.zstd`, out)
  return { sessionId, path: `${sessionDir}/session.v4.jsonl.zstd`, turns: turn, messages: msgs.length }
}

// ════════════ 插件 apply ═══════════

function apply(ctx, config) {
  const dshHome = process.env.DSH_HOME || 'D:\\dsh-home'
  const defaultWorkspace = 'C:\\Users\\yuan\\Desktop\\ai'

  ctx.tools.register(defineTool({
    name: 'import_dialogue',
    description: '把对话文件（Chatbox 的 HTML 导出、JSON 备份 session.json、或手写 Markdown 文本，含思维链）转成 DSH 原生会话文件（session.v4.jsonl.zstd），侧边栏重启后可见、可续写。支持用户/助手/思维 标记的手写格式（用户=user/助手=ai/思维=思考）。',
    parameters: {
      path: { type: 'string', required: true, description: '输入文件路径：.html 导出、.json 备份、含 session.json 的目录、或 .md/.txt 手写对话。' },
      session_id: { type: 'string', description: '会话 id（默认 session-<随机>）。' },
      preset: { type: 'string', description: '预设 id：pure-chat（极简纯聊天，默认）/ pure-chat-web（联网）/ free-tools（自由工具白名单）。' },
      workspace: { type: 'string', description: '会话所属工作区路径（默认当前会话 cwd）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          path: { type: 'string' },
          turns: { type: 'integer' },
          messages: { type: 'integer' },
          preset: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `✅ 已生成会话 \`${value.sessionId}\`（${value.messages} 条消息，${value.turns} 回合，预设 ${value.preset}）。文件：${value.path}\n重启 DSH 后侧边栏可见，可续写。`,
      }],
    },
    async execute(args, exec) {
      const { msgs, title } = loadInput(args.path)
      if (!msgs.length) throw new Error('没解析到消息')
      const cwd = args.workspace || exec.agent?.session?.header?.cwd || defaultWorkspace
      const sessionId = args.session_id || 'session-' + randomUUID()
      const preset = args.preset || 'pure-chat'
      const result = buildSession(msgs, title, { cwd, preset, sessionId, dshHome })
      return { ...result, preset }
    },
  }))
}

export { Config, apply, inject, name }
