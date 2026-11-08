import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

// テストの見本はすべて架空の名前と数字（実在のセッションは使わない）

// ペインを描くときに渡す props（VS Code の狭いパネルと同じ inline の置き方）
const PANE = {
  component: 'Pane',
  requestId: 'session-list',
  props: {
    title: 'セッションリスト',
    isFocused: false,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

// リストと通信の1枚（/session-set）のペイン
const SET = { ...PANE, requestId: 'session-set', props: { ...PANE.props, title: 'セッションリストと通信' } } as const

const NOW = new Date(2026, 9, 18, 9, 0).getTime()
const START = { cwd: 'C:\\work\\space', surface: null, isInteractive: true } as const
const SELF = 'bbbb2222-bbbb'

type Row = { id: string; name: string; status: string; compactions: number; bytes: number; answer: string; summary: string; entrypoint: string }

// セッション表.py の出力の見本（4セッション。このセッションは 監視係）。
// セッションA と 監視係 は最後の答えで g を求めていて、セッションC は はい・いいえ を聞いている。
// セッションD も g を求めているが、作業中なので g を出さない（g を受け取って作業を始めたセッションと同じ）。答えは600字を超える。
// セッションA と 監視係 は VS Code のタブ、セッションC と セッションD はターミナルのセッション
const LONG = 'あ'.repeat(700) + '\nよければ g をお願いします。'

function rows(selfSummary = '見出しの整え方（3点）'): Row[] {
  return [
    { id: 'aaaa1111-aaaa', name: 'セッションA', status: '待機中', compactions: 3, bytes: 40_000_000, answer: '**お返事待ちです。**この形でよければ g をお願いします。', summary: '見出しの直し（2点）', entrypoint: 'claude-vscode' },
    { id: 'cccc3333-cccc', name: 'セッションC', status: '確認待ち', compactions: 1, bytes: 10_000_000, answer: '表を直しました。\nこれでよいですか。', summary: '表を直しました。', entrypoint: 'cli' },
    { id: SELF, name: '監視係', status: '待機中', compactions: 0, bytes: 2_500_000, answer: '見出しをそろえました。\nよろしければ「g」をください。', summary: selfSummary, entrypoint: 'claude-vscode' },
    { id: 'dddd4444-dddd', name: 'セッションD', status: '作業中', compactions: 0, bytes: 1_000_000, answer: LONG, summary: '長い報告', entrypoint: 'cli' },
  ]
}

function ran(stdout: string, exitCode = 0, stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}

type World = { opens: number; opened: Array<{ id: string; focus: boolean }>; stdins: string[]; scripts: string[]; prompts: string[]; argvs: string[][] }

// セッションID・ペイン・セッション表.py を、テストの中で答える
// model は AI の要約の見本（null なら失敗として答える）
function stubWorld(on: On, answer: (call: number) => ProcessRunResult, model?: (prompt: string) => string | null): World {
  const world: World = { opens: 0, opened: [], stdins: [], scripts: [], prompts: [], argvs: [] }
  on('model.complete', ($, e) => {
    world.prompts.push(String(e.prompt))
    const text = model === undefined ? null : model(String(e.prompt))
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    if (text === null) return { value: { isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage } }
    return { value: { isAnswered: true, text, usage } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SELF }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    world.opens += 1
    world.opened.push({ id: e.id, focus: e.focus === true })
    return { value: { isPlaced: true } }
  })
  on('process.run', ($, e) => {
    world.argvs.push([...e.argv])
    // タブを前に出す start は、表の読み直しではないので数えない
    if (e.argv[0] === 'cmd') return { value: ran('') }
    world.scripts.push(e.argv.find(arg => arg.endsWith('.py')) ?? '')
    world.stdins.push(String(e.init?.stdin ?? ''))
    return { value: answer(world.stdins.length) }
  })
  return world
}

type Sent = { to: string; text: string }

// このセッションへの発言と、他のセッションへの送信を、テストの中で受け取る
function stubSend(on: On): { submitted: Array<{ text: string; asUser: boolean }>; sent: Sent[] } {
  const submitted: Array<{ text: string; asUser: boolean }> = []
  const sent: Sent[] = []
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, asUser: e.origin.kind === 'plugin' && e.origin.asUser === true })
    return { text: e.text }
  })
  on('session.send', ($, e) => {
    sent.push({ to: String(e.to), text: e.text })
    return { isDelivered: true }
  })
  return { submitted, sent }
}

async function started($: Engine, on: On, selfSummary?: () => string) {
  const clock = mock.clock(on, { now: NOW })
  const world = stubWorld(on, () => ran(JSON.stringify({ rows: rows(selfSummary?.()), cache: {} })))
  await $.session.start(START)
  await clock.advance(10_000)
  return { clock, world }
}

test('1セッション＝1行の表で、一番右が要約の列になり、このセッションが一番上で薄い橙になる', async ($, on) => {
  const { world } = await started($, on)
  expect(world.opens).toBeGreaterThan(0)
  expect(world.scripts.every(script => script.endsWith('セッション表.py'))).toBe(true)

  for (const surface of ['vscode', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-list', surface, ...PANE })
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    for (const text of ['セッションA', 'セッションC', '監視係']) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    // 見出しの行と、一番右の要約の列（最後の報告の要約）。列名は1〜2文字（10/31 の指示）
    for (const text of ['要約', '名前', '進', '開く', '見出しの直し（2点）', '表を直しました。', '見出しの整え方（3点）']) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    // 前の列名と、消した列（詳しく、状態、ID、送）は出さない。状態は名前の左の丸、ID は開くで写す（11/08 の指示）
    for (const text of ['メッセージ', '進める', '送る文', '詳しく', /^状態$/, /^ID$/, /^送$/, /^作$/, /^待$/, /^確$/]) {
      expect(await ui.find({ type: 'Text', text })).toBeUndefined()
    }
    // メッセージの字は小さくする（10/18 の指示）
    expect((await ui.find({ type: 'Text', text: '見出しの直し（2点）' }))?.props.size).toBe('caption')
    // ログの大きさと圧縮回数は出さない（10/18 の指示）
    for (const text of ['圧縮回数', 'ログの大きさ', '3回']) {
      expect(await ui.find({ type: 'Text', text })).toBeUndefined()
    }
    expect(await ui.find({ type: 'Text', text: /MB/ })).toBeUndefined()
    // 見出しの行は薄い水色
    const heads = (await ui.findAll({ type: 'Box' })).filter(found => found.props.backgroundColor === '#eaf6fc')
    expect(heads.length).toBe(1)
    // 状態は名前の左の色の丸。上から 監視係（待機中）、セッションA（待機中）、セッションC（確認待ち）、セッションD（作業中）
    const dots = (await ui.findAll({ type: 'Text', text: '●' })).map(found => found.props.color)
    expect(dots).toEqual(['#2e7d32', '#2e7d32', '#c00000', '#1f6fb2'])
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts.indexOf('監視係')).toBeLessThan(texts.indexOf('セッションA'))
    const orange = (await ui.findAll({ type: 'Box' })).filter(found => found.props.backgroundColor === '#ffe4c4')
    expect(orange.length).toBe(1)
    // 返事を待っている セッションA（g を求めている）と セッションC（確認待ち）の行は薄い黄色
    const yellow = (await ui.findAll({ type: 'Box' })).filter(found => found.props.backgroundColor === '#fff3c4')
    expect(yellow.length).toBe(2)
    await ui.unmount()
  }
})

test('入力ボックスは無く、g のボタンは g を求めていて作業中でないセッションの行にだけ出る', async ($, on) => {
  await started($, on)
  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  // 送（入力ボックス）の列は無くした（11/08 の指示「送信の列もいらないです」）
  expect((await ui.findAll({ type: 'Input' })).length).toBe(0)
  expect(await ui.find({ type: 'Box', key: 'aaaa1111-aaaa-input' })).toBeUndefined()
  const keys = (await ui.findAll({ type: 'Button' })).map(found => String(found.props.key))
  // セッションD も g を求めているが、作業中なので出さない（g を受け取って作業を始めたら、どの表からも消える）
  expect(keys.filter(key => key.startsWith('g-')).sort()).toEqual(['g-aaaa1111-aaaa', 'g-' + SELF].sort())
  // 詳しくのボタンは無くした（10/31 の指示）
  expect(keys.filter(key => key.startsWith('detail-'))).toEqual([])
  await ui.unmount()
})

test('開くのボタンはすべての行に出て、押すと ID の全体をクリップボードに入れ、VS Code のタブならそのタブを前に出す', async ($, on) => {
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  const { clock, world } = await started($, on)
  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await ui.find({ type: 'Text', text: '開く' })).toBeDefined()
  const keys = (await ui.findAll({ type: 'Button' })).map(found => String(found.props.key))
  // ID の列（写のボタン）は無くした。開くは、このセッションとターミナルのセッションの行にも出す（11/08 の指示）
  expect(keys.filter(key => key.startsWith('id-'))).toEqual([])
  expect(keys.filter(key => key.startsWith('open-')).sort()).toEqual(['open-aaaa1111-aaaa', 'open-cccc3333-cccc', 'open-dddd4444-dddd', 'open-' + SELF].sort())
  await ui.press({ key: 'open-aaaa1111-aaaa' })
  await clock.advance(100)
  await ui.unmount()
  expect(copied).toEqual(['aaaa1111-aaaa'])
  // start の直前に、VS Code から引き継いだ ELECTRON_RUN_AS_NODE を消す（残っていると、起こした VS Code が URL をはねる。11/08）
  expect(world.argvs.filter(argv => argv[0] === 'cmd')).toEqual([
    ['cmd', '/d', '/c', 'set', 'ELECTRON_RUN_AS_NODE=&', 'start', '', 'vscode://anthropic.claude-code/open?session=aaaa1111-aaaa'],
  ])

  // 押した結果は、表の下の1行に出す
  let again = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await again.find({ type: 'Text', text: 'セッションA のタブを前に出しました。ID をコピーしました（aaaa1111-aaaa）' })).toBeDefined()
  // ターミナルのセッションは、ID を写すだけで、start は呼ばない
  await again.press({ key: 'open-cccc3333-cccc' })
  await clock.advance(100)
  await again.unmount()
  expect(copied).toEqual(['aaaa1111-aaaa', 'cccc3333-cccc'])
  expect(world.argvs.filter(argv => argv[0] === 'cmd').length).toBe(1)
  again = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await again.find({ type: 'Text', text: 'セッションC はターミナルのセッションなので、タブは前に出せません。ID をコピーしました（cccc3333-cccc）' })).toBeDefined()
  await again.unmount()
})

test('他のセッションの行の g を押すと、そのセッションへ「g」が届き、その行の g は消える', async ($, on) => {
  const { sent } = stubSend(on)
  const { clock } = await started($, on)
  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  await ui.press({ key: 'g-aaaa1111-aaaa' })
  await clock.advance(100)
  expect(sent.length).toBe(1)
  // ルール【進め方】_09 の3節の印と時刻が付く
  expect(sent[0]?.text).toMatch(/^g（表の g ボタン \d{2}:\d{2}:\d{2}。ルール【進め方】_09 の3節）$/)
  expect(sent[0]?.to).toContain('aaaa1111-aaaa')
  await ui.unmount()

  const after = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await after.find({ type: 'Text', text: /^セッションA へ「g（表の g ボタン/ })).toBeDefined()
  const keys = (await after.findAll({ type: 'Button' })).map(found => String(found.props.key))
  expect(keys).not.toContain('g-aaaa1111-aaaa')
  await after.unmount()
})

test('このセッションの行の g を押すと、使っている人の発言として「g」が入る', async ($, on) => {
  const { submitted, sent } = stubSend(on)
  const { clock } = await started($, on)
  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  await ui.press({ key: 'g-' + SELF })
  await clock.advance(100)
  expect(submitted).toEqual([{ text: 'g', asUser: true }])
  expect(sent).toEqual([])
  await ui.unmount()
})

test('新しい報告が出ると、10秒後の読み直しで2行目の要約が変わる', async ($, on) => {
  let selfSummary = '見出しの整え方（3点）'
  const { clock } = await started($, on, () => selfSummary)
  let ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await ui.find({ type: 'Text', text: '見出しの整え方（3点）' })).toBeDefined()
  await ui.unmount()

  selfSummary = 'テストの結果（9本とも合格）'
  await clock.advance(10_000)
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'テストの結果（9本とも合格）' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '見出しの整え方（3点）' })).toBeUndefined()
  await ui.unmount()
})

test('2回目からは、前の回の控えを標準入力で渡し、増えた分だけを読ませる', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const memo = { 'C:\\logs\\aaaa1111-aaaa.jsonl': { offset: 1234, compactions: 3, title: 'セッションA', answer: 'g をお願いします。' } }
  const world = stubWorld(on, () => ran(JSON.stringify({ rows: rows(), cache: memo })))

  await $.session.start(START)
  await clock.advance(10_000)
  await clock.advance(10_000)

  expect(world.stdins.length).toBeGreaterThan(1)
  expect(world.stdins[0]).toBe('{}')
  expect(JSON.parse(world.stdins.at(-1) ?? '')).toEqual(memo)
})

test('セッション表.py が失敗したら、前の表を残したまま、理由を赤で出す', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on, call => (call === 1 ? ran(JSON.stringify({ rows: rows(), cache: {} })) : ran('', 1, 'ModuleNotFoundError: 架空の失敗')))

  await $.session.start(START)
  await clock.advance(10_000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'セッションA' })).toBeDefined()
  const note = await ui.find({ type: 'Text', text: /セッション表\.py が失敗しました（exit 1）: ModuleNotFoundError/ })
  expect(note).toBeDefined()
  expect(note?.props.color).toBe('#c00000')
  await ui.unmount()
})

test('名前の数字を除いた部分が同じセッションは、同じチームとして続けて並び、左に同じ色の ■ が付く', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // 待機中で返事を待っていない行は出さないので、見本は作業中にする（11/08）
  const teamRows = [
    { id: 'aaaa1111-aaaa', name: '作業1', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '作業1の報告' },
    { id: 'dddd4444-dddd', name: '単独', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '単独の報告' },
    { id: 'eeee5555-eeee', name: '作業2', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '作業2の報告' },
    { id: SELF, name: '監視係', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '監視係の報告' },
  ]
  stubWorld(on, () => ran(JSON.stringify({ rows: teamRows, cache: {} })))
  await $.session.start(START)
  await clock.advance(10_000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  // このセッション（チームなし）が一番上、次に 作業1 と 作業2 のチームが続けて並び、最後に 単独
  expect(texts.indexOf('監視係')).toBeLessThan(texts.indexOf('作業1'))
  expect(texts.indexOf('作業1')).toBeLessThan(texts.indexOf('作業2'))
  expect(texts.indexOf('作業2')).toBeLessThan(texts.indexOf('単独'))
  // チームの2つにだけ、同じ色の ■ が付く
  const marks = await ui.findAll({ type: 'Text', text: '■' })
  expect(marks.length).toBe(2)
  expect(marks[0]?.props.color).toBe(marks[1]?.props.color)
  await ui.unmount()
})

test('返事を待っているセッションは、待っていないセッションより上に出る', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // 待っていない 甲 は作業中（待機中で待っていない行は出さないため。11/08）
  const waitRows = [
    { id: 'aaaa1111-aaaa', name: '甲', status: '作業中', compactions: 0, bytes: 1, answer: 'お返事待ちです。次の指示をお願いします。', summary: '甲の報告' },
    { id: 'cccc3333-cccc', name: '乙', status: '待機中', compactions: 0, bytes: 1, answer: '表を直しました。これでよいですか。', summary: '乙の報告' },
    { id: SELF, name: '監視係', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '監視係の報告' },
  ]
  stubWorld(on, () => ran(JSON.stringify({ rows: waitRows, cache: {} })))
  await $.session.start(START)
  await clock.advance(10_000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.indexOf('監視係')).toBeLessThan(texts.indexOf('乙'))
  expect(texts.indexOf('乙')).toBeLessThan(texts.indexOf('甲'))
  const yellow = (await ui.findAll({ type: 'Box' })).filter(found => found.props.backgroundColor === '#fff3c4')
  expect(yellow.length).toBe(1)
  await ui.unmount()
})

test('チームの中で一番多く連絡を出したセッションが「主」として先頭に出て、主の名前を押すとチームのやり取りが開く', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const MIN = 60_000
  const teamRows = [
    { id: 'aaaa1111-aaaa', name: '作業1', address: '作業1', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '作業1の報告',
      inbox: [{ from: '00-e5', text: '依頼その1', at: NOW - 10 * MIN }, { from: '00-e5', text: '依頼その2', at: NOW - 5 * MIN }] },
    { id: 'eeee5555-eeee', name: '作業2', address: '00-e5', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '作業2の報告',
      inbox: [{ from: '作業1', text: '報告です', at: NOW - 3 * MIN }] },
    { id: SELF, name: '監視係', address: '監視係', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '監視係の報告', inbox: [] },
  ]
  stubWorld(on, () => ran(JSON.stringify({ rows: teamRows, cache: {} })))
  await $.session.start(START)
  await clock.advance(10_000)

  let ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  let texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  // 作業2 が2回、作業1 が1回連絡を出したので、主は 作業2
  expect(texts).toContain('主 作業2')
  expect(texts).toContain('└ 作業1')
  expect(texts.indexOf('主 作業2')).toBeLessThan(texts.indexOf('└ 作業1'))
  expect(texts.some(text => text.includes('作業2 → 作業1'))).toBe(false)
  await ui.press({ key: 'team-作業' })
  await ui.unmount()

  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.some(text => text.includes('作業2 → 作業1  依頼その2'))).toBe(true)
  expect(texts.some(text => text.includes('作業1 → 作業2  報告です'))).toBe(true)
  await ui.unmount()
})

test('待機中で返事を待っていないセッションは表に出さず、出さなかった数を表の下に出す', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const someRows = [
    { id: 'aaaa1111-aaaa', name: '休み1', status: '待機中', compactions: 0, bytes: 1, answer: '', summary: '休み1の報告' },
    { id: 'cccc3333-cccc', name: '休み2', status: '待機中', compactions: 0, bytes: 1, answer: '終わりました。次の指示をお願いします。', summary: '休み2の報告' },
    { id: 'dddd4444-dddd', name: '働き', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '働きの報告' },
    { id: 'eeee5555-eeee', name: '確かめ', status: '確認待ち', compactions: 0, bytes: 1, answer: '', summary: '確かめの報告' },
    { id: 'ffff6666-ffff', name: '問い', status: '待機中', compactions: 0, bytes: 1, answer: 'これでよいですか。', summary: '問いの報告' },
    // このセッションは、待機中で返事を待っていなくても出す
    { id: SELF, name: '監視係', status: '待機中', compactions: 0, bytes: 1, answer: '', summary: '監視係の報告' },
  ]
  stubWorld(on, () => ran(JSON.stringify({ rows: someRows, cache: {} })))
  await $.session.start(START)
  await clock.advance(10_000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  for (const text of ['監視係', '働き', '確かめ', '問い']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  for (const text of ['休み1', '休み2']) {
    expect(await ui.find({ type: 'Text', text })).toBeUndefined()
  }
  expect(await ui.find({ type: 'Text', text: '待機中で返事を待っていない2セッションは、表に出していません' })).toBeDefined()
  await ui.unmount()
})

test('各セッションの最後の答えを AI が1文に要約し、要約の列に出す。同じ答えは1回だけ要約する', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world = stubWorld(on, () => ran(JSON.stringify({ rows: rows(), cache: {} })), prompt =>
    prompt.includes('見出しの直し') ? 'AI要約A' : prompt.includes('表を直しました') ? 'AI要約C' : 'AI要約S')
  await $.session.start(START)
  for (let i = 0; i < 8; i++) await clock.advance(10_000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  for (const text of ['AI要約A', 'AI要約C', 'AI要約S']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  // 題名は、AI の要約に置き換わる
  expect(await ui.find({ type: 'Text', text: '見出しの直し（2点）' })).toBeUndefined()
  expect(world.prompts.length).toBe(4)
  await ui.unmount()
})

test('要約を押すと、その行のすぐ下に最後の報告の終わり600字が開き、もう一度押すと閉じる', async ($, on) => {
  await started($, on)
  let ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  // マウスを載せる箱は無くした（VS Code で出なかったため。11/08）
  expect((await ui.findAll({ type: 'Box' })).filter(found => found.props.position === 'absolute')).toEqual([])
  // 押す前は、最後の報告の終わりは出ていない
  expect(await ui.find({ type: 'Text', text: 'お返事待ちです。この形でよければ g をお願いします。' })).toBeUndefined()
  await ui.press({ key: 'tail-aaaa1111-aaaa' })
  await ui.press({ key: 'tail-dddd4444-dddd' })
  await ui.unmount()

  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  // 太字の記号は除く
  expect(await ui.find({ type: 'Text', text: 'お返事待ちです。この形でよければ g をお願いします。' })).toBeDefined()
  // 600字を超える答えは、終わりの600字の頭に「…」を付けて出す
  const long = await ui.find({ type: 'Text', text: /^…/ })
  expect([...String(long?.text)].length).toBe(601)
  expect(String(long?.text).endsWith('よければ g をお願いします。')).toBe(true)
  // 開いた欄は、押した行のすぐ下に並ぶ
  // 開いた欄は、押した行（セッションA）のすぐ下で、次の行（セッションC）より上に並ぶ
  const keys = (await ui.findAll({ type: 'Box' })).map(found => String(found.key))
  expect(keys.indexOf('tail-box-aaaa1111-aaaa')).toBeGreaterThan(keys.indexOf('row-aaaa1111-aaaa'))
  expect(keys.indexOf('tail-box-aaaa1111-aaaa')).toBeLessThan(keys.indexOf('row-cccc3333-cccc'))
  // もう一度押すと閉じる
  await ui.press({ key: 'tail-aaaa1111-aaaa' })
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'お返事待ちです。この形でよければ g をお願いします。' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^…/ })).toBeDefined()
  await ui.unmount()
})

test('/session-set は、リストと同じ表を別のペインに前に出して開き、セッションが始まっただけでは開かない', async ($, on) => {
  const { clock, world } = await started($, on)
  // 読み込んだときに自分から開くのは /session-list のペインだけ（私の指示「セッションリストだけのコマンド と どちらも入ってる」）
  expect(world.opened.some(one => one.id === 'session-list')).toBe(true)
  expect(world.opened.some(one => one.id === 'session-set')).toBe(false)

  await $.command.run({ command: 'session-set', args: '' })
  await clock.advance(100)
  expect(world.opened.filter(one => one.id === 'session-set')).toEqual([{ id: 'session-set', focus: true }])

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...SET })
  for (const text of ['セッションA', 'セッションC', '監視係', '要約']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  // 矢印の図は セッション間通信MOD が足す。この mod だけでは図を描かない
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})
