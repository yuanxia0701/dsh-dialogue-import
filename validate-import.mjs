// 自检生成的 DSH 会话是否满足 v4 校验规则（复刻关键规则）
import fs from 'node:fs'
import z from 'node:zlib'

const file = process.argv[2]
const buf = fs.readFileSync(file)
const magics = []
for (let i = 0; i < buf.length - 4; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) magics.push(i)
let all = ''
for (let j = 0; j < magics.length; j++) all += z.zstdDecompressSync(buf.subarray(magics[j], j + 1 < magics.length ? magics[j + 1] : buf.length)).toString('utf8')
const lines = all.split('\n').filter(Boolean)
const head = JSON.parse(lines[0])
const events = lines.slice(1).map((l) => JSON.parse(l))

const errors = []
const ok = (cond, msg) => { if (!cond) errors.push(msg) }

// 头部
ok(head.type === 'session' && head.version === 4, '头部 type/version')
ok(head.id.startsWith('session-'), '头部 id 前缀')
ok(head.isSeeded === false, '头部 isSeeded=false')
ok(head.parentSession === undefined, '头部无 parentSession')
ok(typeof head.createdAt === 'number', '头部 createdAt 数字')
ok(typeof head.cwd === 'string', '头部 cwd 字符串')

// seq 连续
ok(events.every((e, i) => e.seq === i), 'seq 连续 0..n')
// 每条有 type/time/data
ok(events.every((e) => typeof e.type === 'string' && typeof e.time === 'number' && e.data && typeof e.data === 'object'), '每条 type/time/data')

// 事件类型都在已知集合
const KNOWN = new Set(['permission/preset','sandbox/mode','approval/policy','session/end-seed','agent-preset/selected','agent/inbox/spliced','turn/start','step/start','system/message','user/message','session/title','request/header','request/context','assistant/message','step/end','turn/end','model/selection'])
for (const e of events) ok(KNOWN.has(e.type), `未知类型 ${e.type}`)

// 消息 source 检查
const SURFACE = new Set(['system/message','user/message','developer/message','assistant/message','tool/result'])
for (const e of events) {
  if (e.type === 'user/message') ok(e.data.source?.kind === 'user' && e.surfaceOp === 'append', `user/message source/surfaceOp @${e.seq}`)
  if (e.type === 'assistant/message') ok(e.data.message?.source?.kind === 'model' && e.surfaceOp === 'append', `assistant/message source/surfaceOp @${e.seq}`)
  if (e.type === 'system/message') ok(e.data.message?.source?.kind === 'system-prompt' && e.surfaceOp === 'append', `system/message source/surfaceOp @${e.seq}`)
  if (e.type === 'request/header') ok(!('system' in (e.data.header || {})), `request/header 无 system @${e.seq}`)
  if (SURFACE.has(e.type) && e.type !== 'user/message' && e.type !== 'assistant/message' && e.type !== 'system/message') ok(e.surfaceOp === 'append', `${e.type} surfaceOp @${e.seq}`)
}

// 顺序校验（复刻 Relationships）
let turn = null, step = null, nextTurn = 1, nextStep = 1
for (const e of events) {
  switch (e.type) {
    case 'turn/start':
      ok(turn === null && e.data.turn === nextTurn, `turn/start 顺序 @${e.seq}`)
      turn = nextTurn; nextStep = 1; break
    case 'turn/end':
      ok(turn !== null && e.data.turn === turn && step === null, `turn/end 顺序 @${e.seq}`)
      turn = null; nextTurn++; break
    case 'step/start':
      ok(turn !== null && e.data.turn === turn && step === null && e.data.step === nextStep, `step/start 顺序 @${e.seq}`)
      step = nextStep; break
    case 'step/end':
      ok(turn !== null && step !== null && e.data.turn === turn && e.data.step === step, `step/end 顺序 @${e.seq}`)
      step = null; nextStep++; break
    case 'assistant/message':
      ok(turn !== null && step !== null && e.data.turn === turn && e.data.step === step, `assistant/message 需开 step @${e.seq}`)
      break
    case 'request/header':
    case 'request/context':
      ok(turn !== null, `${e.type} 需开 turn @${e.seq}`); break
  }
}
ok(nextTurn === events.filter((e) => e.type === 'turn/end').length + 1, 'turn 计数闭合')

// 结果
if (errors.length === 0) console.log('✅ 全部校验通过（' + events.length + ' 事件）')
else { console.log('❌ 发现 ' + errors.length + ' 个问题:'); for (const e of errors) console.log('  - ' + e) }
