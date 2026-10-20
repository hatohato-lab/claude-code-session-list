import { expect, mock, test } from 'claude-code/testing'
import type { FsEntry, FsStat, On, ProcessRunResult } from 'claude-code'

// テストの見本はすべて架空の名前と内容（実在のセッション・連絡は使わない）

// ペインを描くときに渡す props（VS Code の狭いパネルと同じ inline の置き方）
const PANE = {
  component: 'Pane',
  requestId: 'session-list',
  props: {
    title: 'セッション一覧',
    isFocused: false,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

// テストの「いま」。2026-10-17 00:30（ローカル時刻）
const NOW = new Date(2026, 9, 17, 0, 30).getTime()
const MINUTE = 60_000
const WORKSPACE = 'C:\\work\\space'
const START = { cwd: WORKSPACE, surface: null, isInteractive: true } as const

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

// 在席表.py の出力の見本（3セッション。このセッションは 監視係）
const ATTENDANCE = [
  '名前 | セッションID | SendMessage の宛先名 | 状態 | その状態になった時刻',
  'セッションA | aaaa1111 | 00-11 | 待機中 | 10-16 08:38（910分前）',
  '監視係 | bbbb2222 | 00-22 | 待機中 | 10-16 23:47（1分前）',
  'セッションC | cccc3333 | 00-33 | 作業中 | 10-16 23:38（9分前）',
  '宛先名は、セッションを開き直すと変わる。合図を送る直前に、もう一度このコマンドで確かめる。',
].join('\n')

// 合図表.py の出力の見本（合図は2つ、記録は4つ）
//   00:15 監視係 → セッションC: 送った側と受けた側の記録が、宛先の分かる形で届く
//   00:10 セッションA → セッションC: 開き直す前の宛先名（00-9f、00-66）で残った記録を、文面の印で突き合わせる
const BELLS = JSON.stringify({
  offsets: { bbbb2222: 123 },
  bells: [
    { at: iso(NOW - 20 * MINUTE), from: 'aaaa1111', to: '00-9f', via: 'sent', key: 'k2', text: '依頼を書いたと合図' },
    { at: iso(NOW - 20 * MINUTE + 10_000), from: '00-66', to: 'cccc3333', via: 'received', key: 'k2', text: '黒板に依頼を書きました' },
    { at: iso(NOW - 15 * MINUTE), from: 'bbbb2222', to: 'cccc3333', via: 'sent', key: 'k1', text: '黒板に書きました。読んでください。' },
    { at: iso(NOW - 15 * MINUTE + 20_000), from: 'bbbb2222', to: 'cccc3333', via: 'received', key: 'k1', text: '黒板に書きました。読んでください。' },
  ],
})

// 様子表.py の出力の見本。セッションA は返事待ち、セッションC はテストを走らせている最中
function activityJson(quietSecOfC = 5): string {
  return JSON.stringify({
    sessions: [
      {
        id: 'aaaa1111',
        status: 'idle',
        waitingFor: null,
        ask: { at: iso(NOW - 30 * MINUTE), text: '資料の見出しをそろえてください' },
        reply: { at: iso(NOW - 3 * MINUTE), text: '見出しをそろえました。A案とB案のどちらにしますか。お返事待ちです。', awaitsUser: true },
        tool: { at: iso(NOW - 5 * MINUTE), name: 'Edit', detail: '資料.html', done: true },
        quietSec: 180,
        recent: '依頼: 資料の見出しをそろえてください\nClaude: 見出しをそろえました。お返事待ちです。',
        recentKey: 'aaaa000000000001',
        entries: [
          { at: iso(NOW - 30 * MINUTE), kind: 'ask', who: '', text: '資料の見出しをそろえてください', times: 1 },
          { at: iso(NOW - 20 * MINUTE), kind: 'peer-in', who: 'cccc3333', text: '見出しの言葉をそろえる依頼を黒板に書きました', times: 1 },
          { at: iso(NOW - 5 * MINUTE), kind: 'tool', who: '', text: 'Edit 資料.html', times: 3 },
          { at: iso(NOW - 3 * MINUTE), kind: 'claude', who: '', text: '見出しをそろえました。A案とB案のどちらにしますか。お返事待ちです。', times: 1 },
        ],
      },
      { id: 'bbbb2222', status: 'busy', waitingFor: null, ask: null, reply: null, tool: null, quietSec: 1, recent: '', recentKey: '' },
      {
        id: 'cccc3333',
        status: 'busy',
        waitingFor: null,
        ask: { at: iso(NOW - 2 * MINUTE), text: 'テストを直してください' },
        reply: null,
        tool: { at: iso(NOW - 10_000), name: 'Bash', detail: 'テストを走らせる', done: false },
        quietSec: quietSecOfC,
        recent: '依頼: テストを直してください\nClaude: 直します',
        recentKey: 'cccc000000000001',
        entries: [
          { at: iso(NOW - 2 * MINUTE), kind: 'ask', who: '', text: 'テストを直してください', times: 1 },
          { at: iso(NOW - 90_000), kind: 'peer-out', who: 'aaaa1111', text: '見出しの言葉をそろえる依頼', times: 1 },
          { at: iso(NOW - 10_000), kind: 'tool', who: '', text: 'Bash テストを走らせる', times: 1 },
        ],
      },
    ],
  })
}

// 黒板（00_黒板\Claude）のファイル名の見本。今日の2件（1件は既読）と、古い1件
const BOARD_FILES = [
  '20261017_0012_監視係→整理係_報告_資料の整理が終わった_既読.md',
  '20261017_0020_セッションC→セッションA_依頼_見出しの言葉をそろえる.md',
  '20261016_2200_セッションA→監視係_連絡_昨夜の連絡.md',
  '20261011_1032_旅行係→健康係_1010_依頼_切符をまとめて買う.md',
]

// 生ログの大きさの見本。監視係 が一番大きい。proj-old には同じ ID の古くて小さい写しがある
const SIZES: Record<string, number> = {
  'aaaa1111-aaaa.jsonl': 20_000_000,
  'bbbb2222-bbbb.jsonl': 40_000_000,
  'cccc3333-cccc.jsonl': 10_000_000,
}

function file(name: string, size: number, mtimeMs: number): FsEntry {
  return { name, kind: 'file', size, mtimeMs, isLink: false }
}

function entriesOf(path: string): FsEntry[] {
  if (/projects$/.test(path)) {
    return [
      { name: 'proj-old', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'proj-a', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ]
  }
  if (/Claude$/.test(path)) return BOARD_FILES.map(name => file(name, 100, 0))
  if (/proj-old$/.test(path)) return [file('bbbb2222-bbbb.jsonl', 1000, 1)]
  return Object.entries(SIZES).map(([name, size]) => file(name, size, 100))
}

function statOf(path: string): FsStat {
  const name = path.split(/[\\/]/).pop() ?? ''
  const size = /proj-old/.test(path) ? 1000 : (SIZES[name] ?? 0)
  return { kind: 'file', size, mtimeMs: 0, isLink: false }
}

function ran(stdout: string, exitCode: number, stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

type World = { scripts: string[]; opens: number; focused: number; summaries: string[] }

// 在席表.py・合図表.py・様子表.py・黒板・生ログ・ホーム・要約のモデルを、テストの中で答える。boardExists が false なら、黒板のフォルダーが無い人
function stubWorld(on: On, attendance: ProcessRunResult, quietSecOfC = 5, boardExists = true): World {
  const world: World = { scripts: [], opens: 0, focused: 0, summaries: [] }
  mock.env(on, { USERPROFILE: 'C:\\home\\test' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'bbbb2222-bbbb' }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    world.opens += 1
    if (e.focus) world.focused += 1
    return { value: { isPlaced: true } }
  })
  on('process.run', ($, e) => {
    const script = e.argv.find(arg => arg.endsWith('.py')) ?? ''
    world.scripts.push(script)
    if (script.endsWith('合図表.py')) return { value: ran(BELLS, 0) }
    if (script.endsWith('様子表.py')) return { value: ran(activityJson(quietSecOfC), 0) }
    return { value: attendance }
  })
  on('fs.exists', ($, e) => ({ value: /Claude$/.test(e.path) ? boardExists : true }))
  on('fs.list', ($, e) => ({ value: entriesOf(e.path) }))
  on('fs.stat', ($, e) => ({ value: statOf(e.path) }))
  on('model.complete', ($, e) => {
    world.summaries.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: 'いま: 見出しをそろえている\n次: 人の返事待ち',
        usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  return world
}

test('名前・ID・宛先名・1文字の状態が並び、狭い棒の長さが生ログの大きさに比例する（詳しい表示）', { options: { view: 'detail' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = stubWorld(on, ran(ATTENDANCE, 0))

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  // 在席表.py と合図表.py は、MOD に同梱した tools から呼ばれる（作業フォルダーの 00_黒板 には頼らない）
  expect(world.scripts.some(script => /[\\/]tools[\\/]在席表\.py$/.test(script))).toBe(true)
  expect(world.scripts.some(script => /[\\/]tools[\\/]合図表\.py$/.test(script))).toBe(true)
  expect(world.scripts.some(script => script.startsWith(WORKSPACE))).toBe(false)
  expect(world.scripts.some(script => script.endsWith('様子表.py'))).toBe(true)

  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-list', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'セッションA' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'bbbb2222' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '00-22' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '作' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '待' })).toBeDefined()
    // 古い写し（proj-old、1000 バイト）ではなく、新しい方の生ログの大きさが出る
    expect(await ui.find({ type: 'Text', text: '38.1' })).toBeDefined()
    const bars = (await ui.findAll({ type: 'Text', text: /█/ })).map(found => found.text.length)
    expect(bars.length).toBe(3)
    expect(Math.max(...bars)).toBeLessThan(7)
    expect(Math.max(...bars)).toBeGreaterThan(Math.min(...bars))
    await ui.unmount()
  }
})

test('返事待ちのセッションが一番上に赤で出て、作業中のセッションはいまの道具が出る（詳しい表示）', { options: { view: 'detail' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0))

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const need = await ui.find({ type: 'Text', text: /⚠ 返 セッションA　返事待ち/ })
  expect(need).toBeDefined()
  expect(need?.props.color).toBe('#c00000')
  expect(await ui.find({ type: 'Text', text: /A案とB案のどちらにしますか/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Bash テストを走らせる（実行中）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /指示 .*「テストを直してください」/ })).toBeDefined()
  await ui.unmount()
})

test('道具を使ったまま生ログが止まっていると「承認待ちかも」を黄色で出す（詳しい表示）', { options: { view: 'detail' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0), 45)

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const need = await ui.find({ type: 'Text', text: /⚠ 承 セッションC　承認待ちかも/ })
  expect(need).toBeDefined()
  expect(need?.props.backgroundColor).toBe('#fff3c4')
  await ui.unmount()
})

test('会話の地図が図（SVG）で描かれ、ターミナルでは文の案内に変わる（詳しい表示）', { options: { view: 'detail' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0))

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  const source = String(svg?.props.source ?? '')
  expect(source).toContain('セッションA')
  expect(source).toContain('監視係')
  expect(source).toContain('整理係')
  // 話している2つを1組1行にする。両方から連絡した組（セッションA と セッションC）は、線の両端に矢印が付く
  expect(source).not.toContain('送った側')
  expect(source).toContain('marker-start')
  expect(source).toContain('marker-end')
  expect(source).not.toContain('stroke-dasharray')
  // 組は4つ（A⇄C、監視係→整理係、監視係→C、A→監視係）なので、線も4本
  expect(source.split('<line ').length - 1).toBe(4)
  // 両方から連絡した組は、1本の線の両端に矢印が付く
  expect(source).toMatch(/<line [^>]*marker-end="[^"]*"[^>]*marker-start="[^"]*"/)
  // やり取りのない古い相手（旅行係）は出さない
  expect(source).not.toContain('旅行係')
  // 画面を取りすぎない（4組で、高さ 110px 未満）
  const height = Number(/height="(\d+)"/.exec(source)?.[1] ?? '9999')
  expect(height).toBeLessThan(110)
  // 「隠す」を押すと地図が消え、「出す」で戻る
  await ui.press({ key: 'toggle-map' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.press({ key: 'toggle-map' })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()

  const term = await $.ui.mount({ plugin: 'session-list', surface: 'terminal', ...PANE })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /つながりの図は VS Code/ })).toBeDefined()
  await term.unmount()
})

test('様子が変わったセッションを小さなモデルで2行に要約して出す（詳しい表示）', { options: { view: 'detail' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = stubWorld(on, ran(ATTENDANCE, 0))

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  expect(world.summaries.length).toBeGreaterThan(0)
  expect(world.summaries[0]).toContain('資料の見出しをそろえてください')
  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await ui.find({ type: 'Text', text: '　要約 いま: 見出しをそろえている ／ 次: 人の返事待ち' })).toBeDefined()
  await ui.unmount()
})

test('要約の設定を切ると、モデルを呼ばない（詳しい表示）', { options: { view: 'detail', summaries: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = stubWorld(on, ran(ATTENDANCE, 0))

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(30_000)

  expect(world.summaries.length).toBe(0)
})

test('/sessions は、ほかの mod のペインより前に出す指定（focus）を付けてペインを開く', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = stubWorld(on, ran(ATTENDANCE, 0))

  await $.session.start(START)
  expect(world.opens).toBe(0)
  await $.command.run({ command: 'sessions', args: '' })
  // /sessions が裏で始める読み直しを、テストの終わりまでに済ませる
  await clock.advance(2000)

  expect(world.opens).toBe(1)
  expect(world.focused).toBe(1)
})

test('黒板のフォルダーが無い人には、黒板の連絡が出ず、読めないという赤も出ない（詳しい表示）', { options: { view: 'detail' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0), 5, false)

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await ui.find({ type: 'Text', text: '直近24時間のやり取り（黒板 0件・合図 2件）' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /黒板を読めません/ })).length).toBe(0)
  expect((await ui.findAll({ type: 'Text', text: 'セッションC → セッションA' })).length).toBe(0)
})

test('今日の黒板の連絡と合図が「送り主 → 宛先」で並び、未読と相手が分かる（詳しい表示）', { options: { view: 'detail' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0))

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  // 送った側と受けた側の記録は、1つの合図にまとまる（4つの記録が2つの合図になる）
  expect(await ui.find({ type: 'Text', text: '直近24時間のやり取り（黒板 3件・合図 2件）' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '監視係 → 整理係' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'セッションC → セッションA' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '監視係 🔔→ セッションC' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'セッションA 🔔→ セッションC' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /00-9f|00-66/ })).length).toBe(0)
  expect(await ui.find({ type: 'Text', text: '既読' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '未読' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /旅行係/ })).length).toBe(0)
  // 直近30分の相手が名前の横に出る
  expect(await ui.find({ type: 'Text', text: '監視係 ⇄セッションC' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'セッションA ⇄セッションC' })).toBeDefined()
  await ui.unmount()
})

test('既定では、セッション間のやり取りをシーケンス図（縦の線と横の矢印）で描く（要約は動かさない）', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = stubWorld(on, ran(ATTENDANCE, 0))

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(30_000)

  expect(world.summaries.length).toBe(0)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  // 図だけ。入力欄・名簿の表・ボタンは出さない
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  for (const word of [/返事待ち/, /^名前$/, /^ID$/, /要約/, /ログMB/]) {
    expect((await ui.findAll({ type: 'Text', text: word })).length).toBe(0)
  }
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  const source = String(svg?.props.source ?? '')
  // 白い背景に黒い文字。縦の線（セッション）。作業中のセッションC は青い帯
  expect(source).toContain('fill="#ffffff"')
  expect(source).not.toContain('#0d1117')
  for (const name of ['セッションA', '監視係', 'セッションC']) expect(source).toContain('>' + name + '<')
  expect(source).toContain('fill="#1f6fb2" fill-opacity="0.35"')
  // 閉じたセッション（名簿にない整理係）は、縦の線も、その相手との矢印も出さない
  expect(source).not.toContain('整理係')
  expect(source).not.toContain('stroke-dasharray="6 6"')
  expect(source).not.toContain('>閉じた<')
  // このセッション（監視係）は一番左に置き、名札と縦の棒を薄い橙にする。名札の字は 15px
  expect(source.indexOf('>監視係<')).toBeLessThan(source.indexOf('>セッションA<'))
  expect(source).toContain('fill="#ffe4c4" stroke="#e8913a"')
  expect(source).toContain('fill="#f5a04a" fill-opacity="0.45"')
  expect(source).toContain('font-size="15">監視係<')
  // 横の矢印（合図は橙、黒板は青。細い線に小さな矢じり）と、矢印の上の件名
  expect(source).toContain('marker-end="url(#seqBell)"')
  expect(source).toContain('marker-end="url(#seqBoard)"')
  expect(source).toContain('markerWidth="5"')
  expect(source).toContain('stroke-width="1.5" marker-end=')
  expect(source).toContain('見出しの言葉をそろえる')
  // 文字はすべて黒（灰色の文字は使わない）
  expect(source).not.toMatch(/<text[^>]*fill="#(?!000000)/)
  // 幅いっぱいに広がり、マウスを載せると詳しい情報（<title>）が出る
  expect(source).toContain('width="100%"')
  expect(svg?.props.isInteractive).toBe(true)
  expect(source).toContain('<title>00:20（10分前）　セッションC → セッションA\n黒板・依頼・未読')
  // 名札の下に、状態（1語だけ）
  expect(source).toContain('>作<')
  // 行を詰め、図の高さは行の数だけ（3行なら 44＋36×3＋16＝168）
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(source)
  expect(Number(vb?.[2] ?? 0)).toBe(168)
  // 色の説明の文は出さない
  expect((await ui.findAll({ type: 'Text', text: /縦の線＝/ })).length).toBe(0)
  // 直近24時間の5件（黒板3・合図2）から、閉じた相手（整理係）との1件を除いた4件が、上から古い順に並ぶ
  expect(source.split('marker-end=').length - 1).toBe(4)
  expect(source.indexOf('>22:00<')).toBeLessThan(source.indexOf('>00:20<'))
  // 古い相手（旅行係）は出さない
  expect(source).not.toContain('旅行係')
  await ui.unmount()

  // ターミナル（図を描けない）では、1行ずつの文に変わる
  const term = await $.ui.mount({ plugin: 'session-list', surface: 'terminal', ...PANE })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /監視係 🔔→ セッションC/ })).toBeDefined()
  await term.unmount()
})

test('送り先が「このセッション」のまま送ると、使っている人の発言として送られる（詳しい表示）', { options: { view: 'detail' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0))
  const submitted: Array<{ text: string; asUser: boolean }> = []
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, asUser: e.origin.kind === 'plugin' && e.origin.asUser === true })
    return { text: e.text }
  })

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const field = await ui.find({ type: 'Input' })
  expect(field).toBeDefined()
  await ui.input({ key: field?.key ?? '', text: 'テストの発言' })
  expect(submitted).toEqual([{ text: 'テストの発言', asUser: true }])
  expect(await ui.find({ type: 'Text', text: /このセッションへ送りました/ })).toBeDefined()
  await ui.unmount()
})

test('送り先に相手を選んで送ると、設定の呼び名を頭に付けてそのセッションへ届く（詳しい表示）', { options: { view: 'detail', senderName: '送り主' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0))
  const sent: Array<{ to: string; text: string }> = []
  on('session.send', ($, e) => {
    sent.push({ to: typeof e.to === 'string' ? e.to : JSON.stringify(e.to), text: e.text })
    return { isDelivered: true }
  })

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  await ui.select({ key: 'target', value: 'cccc3333' })
  const field = await ui.find({ type: 'Input' })
  await ui.input({ key: field?.key ?? '', text: '黒板を見てください' })
  expect(sent.length).toBe(1)
  expect(sent[0]?.to).toContain('cccc3333')
  expect(sent[0]?.text).toContain('黒板を見てください')
  expect(sent[0]?.text).toContain('（送り主が監視画面の入力欄から送った文です）')
  // 返事の返し方（先頭の目印と、送り主のセッション名）を添える
  expect(sent[0]?.text).toContain('【監視画面へ:cccc3333】')
  expect(sent[0]?.text).toContain('監視画面を開いているセッション「監視係」')
  expect(await ui.find({ type: 'Text', text: 'セッションC へ送りました' })).toBeDefined()
  // 一番下の「この画面からのやり取り」に、送った文が出る
  expect(await ui.find({ type: 'Text', text: /→ セッションC「黒板を見てください」　届いた/ })).toBeDefined()
  await ui.unmount()
})

test('目印の付いた返事は、この画面のやり取りに出し、このセッションの AI には渡さない', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0))
  const reachedModel: string[] = []
  on('session.receive', ($, e) => {
    reachedModel.push(e.text)
    return { text: e.text }
  })

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  const marked = await $.session.receive({ origin: { kind: 'peer' }, text: '【監視画面へ:cccc3333】見ました。3本とも合格です' })
  expect(marked.consumed).toBeDefined()
  const plain = await $.session.receive({ origin: { kind: 'peer' }, text: 'ふつうの連絡です' })
  expect(plain.text).toBe('ふつうの連絡です')
  expect(reachedModel).toEqual(['ふつうの連絡です'])

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const line = await ui.find({ type: 'Text', text: /← セッションC「見ました。3本とも合格です」/ })
  expect(line).toBeDefined()
  expect(line?.props.color).toBe('#1f6fb2')
  await ui.unmount()
})

test('ほかのセッションの入力欄から届いた連絡は、返し方の目印がこのセッションの ID なので、AI に渡す', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0))
  const reachedModel: string[] = []
  on('session.receive', ($, e) => {
    reachedModel.push(e.text)
    return { text: e.text }
  })

  // ペインを開いていないセッションでも、同じ MOD が入っていれば受け取りの hook は動く
  await $.session.start(START)
  await clock.advance(2000)

  // 送る側の MOD は、文の終わりに「先頭に【監視画面へ:受け取る側の ID】と付けて返して」を添える。このセッションの ID は bbbb2222
  const request = '（監視画面の入力欄から、使っている人が直接打った文です）\n見出しをそろえてください\n' +
    '（返事をするときは、先頭に【監視画面へ:bbbb2222】と付けて、この連絡の送り主へ SendMessage で1〜2行で返してください。）〔送り主:cccc3333〕'
  const passed = await $.session.receive({ origin: { kind: 'peer' }, text: request })
  expect(passed.consumed).toBeUndefined()
  expect(reachedModel).toEqual([request])
})

test('呼び名の設定が空なら、名前を付けずに送る（詳しい表示）', { options: { view: 'detail' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0))
  const sent: string[] = []
  on('session.send', ($, e) => {
    sent.push(e.text)
    return { isDelivered: true }
  })

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  await ui.select({ key: 'target', value: 'aaaa1111' })
  const field = await ui.find({ type: 'Input' })
  await ui.input({ key: field?.key ?? '', text: 'こんにちは' })
  expect(sent[0]).toContain('（監視画面の入力欄から、使っている人が直接打った文です）')
  await ui.unmount()
})

test('セッションが始まっただけでは、ペインを開かず、在席表.py も回さない（/sessions で初めて動く）', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = stubWorld(on, ran(ATTENDANCE, 0))

  await $.session.start(START)
  await clock.advance(10_000)
  expect(world.opens).toBe(0)
  expect(world.scripts.length).toBe(0)
  expect(world.summaries.length).toBe(0)

  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)
  expect(world.opens).toBe(1)
  expect(world.scripts.length).toBeGreaterThan(0)
})

test('在席表.py が失敗したら、ペインに理由が出る', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran('', 1, 'boom'))

  await $.session.start(START)
  await $.command.run({ command: 'sessions', args: '' })
  await clock.advance(2000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /在席表\.py が失敗しました/ })).toBeDefined()
  await ui.unmount()
})

test('セッション情報MOD の表のペインに、円グラフとやり取りの図を足して1枚にする', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, ran(ATTENDANCE, 0))
  // セッション情報MOD の表の代わり（この mod より後ろで描く mod）
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'セッション情報の表（試験用）' }))

  await $.session.start(START)
  const INFO = { ...PANE, requestId: 'session-info', props: { ...PANE.props, title: 'セッション情報' } } as const
  // 表のペインを描くと、この mod が数字を読み始める
  const first = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...INFO })
  await first.unmount()
  await clock.advance(30_000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...INFO })
  // 表（ほかの mod が描いたもの）が上に残り、その下に円グラフと図が足される
  expect(await ui.find({ type: 'Text', text: 'セッション情報の表（試験用）' })).toBeDefined()
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.length).toBe(2)
  const pie = String(svgs[0]?.props.source ?? '')
  expect(pie).toContain('生ログの大きさの割合（試し）')
  // 生ログが一番大きい監視係が先に並ぶ
  expect(pie.indexOf('監視係')).toBeLessThan(pie.indexOf('セッションA'))
  expect(pie).toContain('<path d="M110,105')
  const diagram = String(svgs[1]?.props.source ?? '')
  expect(diagram).toContain('>監視係<')
  await ui.unmount()
})
