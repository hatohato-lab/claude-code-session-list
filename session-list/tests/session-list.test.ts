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

type World = { opens: number; opened: Array<{ id: string; focus: boolean }>; stdins: string[]; scripts: string[]; prompts: string[]; systems: string[]; argvs: string[][]; nows: string[] }

// セッションID・ペイン・セッション表.py を、テストの中で答える
// model は AI の要約の見本（null なら失敗として答える）
function stubWorld(on: On, answer: (call: number) => ProcessRunResult, model?: (prompt: string) => string | null): World {
  const world: World = { opens: 0, opened: [], stdins: [], scripts: [], prompts: [], systems: [], argvs: [], nows: [] }
  on('model.complete', ($, e) => {
    world.prompts.push(String(e.prompt))
    world.systems.push(String(e.system ?? ''))
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
    // g を押したときの確かめ（--now）は、いまの表の材料から、そのセッションの状態と答えを返す。表の読み直しには数えない
    const nowAt = e.argv.indexOf('--now')
    if (nowAt >= 0) {
      const id = String(e.argv[nowAt + 1])
      world.nows.push(id)
      try {
        const listed = JSON.parse(answer(world.stdins.length).stdout) as { rows?: Row[] }
        const found = (listed.rows ?? []).find(one => one.id === id)
        return { value: ran(JSON.stringify(found === undefined ? { status: '閉じている', answer: '' } : { status: found.status, answer: found.answer })) }
      } catch {
        return { value: ran('', 1, '読めません') }
      }
    }
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
    for (const text of ['要約', '名前', '進', /^開$/, '見出しの直し（2点）', '表を直しました。', '見出しの整え方（3点）']) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined()
    }
    // 前の列名と、消した列（詳しく、状態、ID、送）は出さない。状態は名前の左の丸と要約の先頭の【 】、ID は「開」を押すと写す（11/08、11/15 の指示）
    for (const text of ['メッセージ', '進める', '送る文', '詳しく', /^状態$/, /^ID$/, /^送$/, /^作$/, /^待$/, /^確$/, /^開く$/]) {
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

test('開のボタンはすべての行に出て、押すと ID の全体をクリップボードに入れ、VS Code のタブならそのタブを前に出す。要約は押せない文で出す', async ($, on) => {
  // 11/15 の朝の指示で、同じ動きを要約のボタンに移して開くの列を無くした。同じ日の指示「灰色の文字のフォントはやめて下さい全部ですね。
  // 黒の濃い字にして下さい」で、要約を黒い字の文にし、「開」のボタンに戻した。VS Code は、押せるボタンの中の字を黒にさせない
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  const { clock, world } = await started($, on)
  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  // 見出しの行に「開」がある
  expect(await ui.find({ type: 'Text', text: /^開$/ })).toBeDefined()
  const keys = (await ui.findAll({ type: 'Button' })).map(found => String(found.props.key))
  // 要約のボタン、ID のボタン、600字を開くボタンは無い
  expect(keys.filter(key => key.startsWith('id-') || key.startsWith('summary-') || key.startsWith('tail-'))).toEqual([])
  // 「開」のボタンは、このセッションとターミナルのセッションの行にも出す
  expect(keys.filter(key => key.startsWith('open-')).sort()).toEqual(['open-aaaa1111-aaaa', 'open-cccc3333-cccc', 'open-dddd4444-dddd', 'open-' + SELF].sort())
  for (const id of ['aaaa1111-aaaa', 'cccc3333-cccc', 'dddd4444-dddd', SELF]) {
    expect((await ui.find({ type: 'Box', key: id + '-open' }))?.props.width).toBe(5)
  }
  await ui.press({ key: 'open-aaaa1111-aaaa' })
  await clock.advance(100)
  await ui.unmount()
  expect(copied).toEqual(['aaaa1111-aaaa'])
  // start の直前に、VS Code から引き継いだ ELECTRON_RUN_AS_NODE を消す（残っていると、起こした VS Code が URL をはねる。11/08）
  expect(world.argvs.filter(argv => argv[0] === 'cmd')).toEqual([
    ['cmd', '/d', '/c', 'set', 'ELECTRON_RUN_AS_NODE=&', 'start', '', 'vscode://anthropic.claude-code/open?session=aaaa1111-aaaa'],
  ])

  // うまくいったときは、表の下に何も出さない（11/14 の指示「この下に表示されているのはもう表示しなくていいです」）
  let again = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await again.find({ type: 'Text', text: /タブを前に出しました|ID をコピーしました/ })).toBeUndefined()
  // 押しても、行の下に最後の報告の終わりは開かない（11/15 の指示「クリックして中身が見えるのは、中止してください」）
  expect(await again.find({ type: 'Text', text: 'お返事待ちです。この形でよければ g をお願いします。' })).toBeUndefined()
  expect((await again.findAll({ type: 'Box' })).filter(found => String(found.key).startsWith('tail-box-'))).toEqual([])
  // ターミナルのセッションは、ID を写すだけで、start は呼ばない。前に出すタブが無いことだけは、表の下に出す
  await again.press({ key: 'open-cccc3333-cccc' })
  await clock.advance(100)
  await again.unmount()
  expect(copied).toEqual(['aaaa1111-aaaa', 'cccc3333-cccc'])
  expect(world.argvs.filter(argv => argv[0] === 'cmd').length).toBe(1)
  again = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await again.find({ type: 'Text', text: 'セッションC はターミナルのセッションなので、タブは前に出せません（ID はコピーしました）' })).toBeDefined()
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
  // 送れたときは、表の下に何も出さない（11/14 の指示「この下に表示されているのはもう表示しなくていいです」）
  expect(await after.find({ type: 'Text', text: /へ「g/ })).toBeUndefined()
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

test('g を押したとき、相手がもう作業を始めていたら、g を送らずにボタンを消し、理由を表の下に出す', async ($, on) => {
  // 11/14 の指示「自分のテキストボックスで g を押した場合は、ボタン消えないですよね。だから不整合が生じる」
  const clock = mock.clock(on, { now: NOW })
  let current = rows()
  const world = stubWorld(on, () => ran(JSON.stringify({ rows: current, cache: {} })))
  const { sent } = stubSend(on)
  await $.session.start(START)
  await clock.advance(10_000)
  // 表を読み直したあとで、セッションA がテキストボックスの g で作業を始めた（表はまだ読み直していない）
  current = rows().map(row => (row.id === 'aaaa1111-aaaa' ? { ...row, status: '作業中' } : row))
  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  await ui.press({ key: 'g-aaaa1111-aaaa' })
  await clock.advance(100)
  expect(world.nows).toEqual(['aaaa1111-aaaa'])
  expect(sent).toEqual([])
  await ui.unmount()

  const after = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await after.find({ type: 'Text', text: 'セッションA はもう作業を始めていたので、g を送りませんでした' })).toBeDefined()
  const keys = (await after.findAll({ type: 'Button' })).map(found => String(found.props.key))
  expect(keys).not.toContain('g-aaaa1111-aaaa')
  await after.unmount()
})

test('g を押したとき、相手が新しい答えを出していたら、g を送らず、読み直したあとで新しい問いの g を出す', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let current = rows()
  stubWorld(on, () => ran(JSON.stringify({ rows: current, cache: {} })))
  const { sent } = stubSend(on)
  await $.session.start(START)
  await clock.advance(10_000)
  // 表を読み直したあとで、セッションA が次の答えを出した（また g を求めているが、まだ表に出ていない問い）
  const next = '次の段に進みます。\n**お返事待ちです。**この形でよければ g を押してください。'
  current = rows().map(row => (row.id === 'aaaa1111-aaaa' ? { ...row, answer: next } : row))
  let ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  await ui.press({ key: 'g-aaaa1111-aaaa' })
  await clock.advance(100)
  expect(sent).toEqual([])
  await ui.unmount()

  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'セッションA は新しい答えを出していたので、g を送りませんでした' })).toBeDefined()
  await ui.unmount()
  // 次の読み直しで、新しい問いに対する g が出る
  await clock.advance(10_000)
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const keys = (await ui.findAll({ type: 'Button' })).map(found => String(found.props.key))
  expect(keys).toContain('g-aaaa1111-aaaa')
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

test('g 待ち、このセッション、確認待ち、作業中、文で答える問いの順に並ぶ', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // 11/14 に決めた順（入りきらない行をたたむときに、表から操作する行と作業中の行が上に残るようにする）を、11/15 に直した。
  // g 待ちの行を、このセッションの行より上の一番上に置く（11/15 の指示「g で待つリストを優先的に上に表示させるようにしたいです」）。
  // 前は、このセッションが一番上で、g 待ちと確認待ちが同じ大事さだった
  const waitRows = [
    { id: 'aaaa1111-aaaa', name: '甲', status: '作業中', compactions: 0, bytes: 1, answer: 'お返事待ちです。次の指示をお願いします。', summary: '甲の報告' },
    { id: 'cccc3333-cccc', name: '乙', status: '待機中', compactions: 0, bytes: 1, answer: '表を直しました。これでよいですか。', summary: '乙の報告' },
    { id: 'dddd4444-dddd', name: '丙', status: '待機中', compactions: 0, bytes: 1, answer: 'お返事待ちです。この形でよければ g を押してください。', summary: '丙の報告' },
    { id: 'eeee5555-eeee', name: '丁', status: '確認待ち', compactions: 0, bytes: 1, answer: '', summary: '丁の報告' },
    { id: SELF, name: '監視係', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '監視係の報告' },
  ]
  let current = waitRows
  stubWorld(on, () => ran(JSON.stringify({ rows: current, cache: {} })))
  const { sent } = stubSend(on)
  await $.session.start(START)
  await clock.advance(10_000)

  let ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  // いまの表で、名前が上から順に並んでいるか
  const inOrder = async (names: string[]) => {
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    const order = names.map(name => texts.indexOf(name))
    return order.every(at => at >= 0) && [...order].sort((a, b) => a - b).join() === order.join()
  }
  // 丙（g 待ち）、監視係（このセッション）、丁（確認待ち）、甲（作業中）、乙（文で答える問い）
  expect(await inOrder(['丙', '監視係', '丁', '甲', '乙'])).toBe(true)
  // 返事を待っている 乙、丙、丁 は薄い黄色
  const yellow = (await ui.findAll({ type: 'Box' })).filter(found => found.props.backgroundColor === '#fff3c4')
  expect(yellow.length).toBe(3)

  // g を押しても、相手が作業を始めるまでは、行の場所を変えない。押したとたんに行が下へ動くと、
  // 下の行が上に詰まり、続けて押そうとした別の行の g を押し違えるため。g のボタンだけが消える
  await ui.press({ key: 'g-dddd4444-dddd' })
  await clock.advance(100)
  expect(sent.length).toBe(1)
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await inOrder(['丙', '監視係', '丁', '甲', '乙'])).toBe(true)
  expect((await ui.findAll({ type: 'Button' })).map(found => String(found.props.key))).not.toContain('g-dddd4444-dddd')
  await ui.unmount()

  // 相手が作業を始めると、次の読み直しで、作業中の場所へ動く
  current = waitRows.map(row => (row.id === 'dddd4444-dddd' ? { ...row, status: '作業中' } : row))
  await clock.advance(10_000)
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await inOrder(['監視係', '丁', '甲', '丙', '乙'])).toBe(true)
  await ui.unmount()
})

test('チームの中の g 待ちの行は、チームから離して一番上に出し、g 待ちどうしでは、このセッションが先になる', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // チームごと上に動かすと、g 待ちでない 組1 が、g 待ちの 丙 やこのセッションより上に来て、「g 待ちが一番上」にならない。
  // そこで、g 待ちの 組2 だけをチームから離して一番上に出す。左の線と ■ は、チームの色のまま残す。
  // 同じ g 待ちなら、チームから離した行（組2）、チームの無いセッション（丙）の順。組1 は、文で答える問いの所に残る
  const teamRows = [
    { id: 'aaaa1111-aaaa', name: '組1', status: '待機中', compactions: 0, bytes: 1, answer: '表を直しました。これでよいですか。', summary: '組1の報告' },
    { id: 'cccc3333-cccc', name: '組2', status: '待機中', compactions: 0, bytes: 1, answer: 'お返事待ちです。この形でよければ g を押してください。', summary: '組2の報告' },
    { id: 'dddd4444-dddd', name: '丙', status: '待機中', compactions: 0, bytes: 1, answer: 'お返事待ちです。よければ g を押してください。', summary: '丙の報告' },
    { id: 'eeee5555-eeee', name: '丁', status: '確認待ち', compactions: 0, bytes: 1, answer: '', summary: '丁の報告' },
    { id: SELF, name: '監視係', status: '作業中', compactions: 0, bytes: 1, answer: '', summary: '監視係の報告' },
  ]
  let current = teamRows
  stubWorld(on, () => ran(JSON.stringify({ rows: current, cache: {} })))
  await $.session.start(START)
  await clock.advance(10_000)

  let ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  let texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  let order = ['組2', '丙', '監視係', '丁', '組1'].map(name => texts.indexOf(name))
  expect(order.every(at => at >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  // 離れても、組1 と 組2 の2行に、同じ色の ■ が付く
  const marks = await ui.findAll({ type: 'Text', text: '■' })
  expect(marks.length).toBe(2)
  expect(marks[0]?.props.color).toBe(marks[1]?.props.color)
  // チームのやり取りを開くボタン（チームの先頭の名前）は、残った 組1 の1つだけ
  const teamKeys = (await ui.findAll({ type: 'Button' })).map(found => String(found.props.key)).filter(key => key.startsWith('team-'))
  expect(teamKeys).toEqual(['team-組'])
  await ui.unmount()

  // このセッションも g 待ちになると、g 待ちのまとまりの中で、このセッションが一番上になる
  current = teamRows.map(row => (row.id === SELF ? { ...row, status: '待機中', answer: 'お返事待ちです。よければ g を押してください。' } : row))
  await clock.advance(10_000)
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  order = ['監視係', '組2', '丙', '丁', '組1'].map(name => texts.indexOf(name))
  expect(order.every(at => at >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  await ui.unmount()
})

test('ペインに入りきらない行は、大事な順に入る分だけ出し、残りは見出しの行の「ほか N を開く」にまとめる', async ($, on) => {
  // 11/14 の指示「スクロールが発生しないようにしたいです」。VS Code の入力欄の上のペインは12行分までで、実際に入るのは11行。
  // 見出しの1行と、10セッションだけを出す
  const clock = mock.clock(on, { now: NOW })
  const many = [
    { id: SELF, name: '監視係', status: '待機中', compactions: 0, bytes: 1, answer: '', summary: '監視係の報告' },
    ...Array.from({ length: 12 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0')
      // 01〜09 は文で答える問い、10 は g 待ち、11 は作業中、12 は確認待ち
      const status = i === 10 ? '作業中' : i === 11 ? '確認待ち' : '待機中'
      const answer = i === 9 ? 'お返事待ちです。よければ g を押してください。' : 'お返事待ちです。型番を教えてください。'
      return { id: 'row-' + n, name: '係' + n, status, compactions: 0, bytes: 1, answer, summary: '係' + n + 'の報告' }
    }),
  ]
  stubWorld(on, () => ran(JSON.stringify({ rows: many, cache: {} })))
  await $.session.start(START)
  await clock.advance(10_000)

  let ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  // いま描かれているセッションの行の箱（row-…）を、上から順に返す
  const rowKeys = async () =>
    (await ui.findAll({ type: 'Box' })).map(found => String(found.key)).filter(key => key.startsWith('row-row-') || key === 'row-' + SELF)
  // 13セッションのうち10だけを出す。g 待ち（係10）、このセッション、確認待ち（係12）、作業中（係11）が上に残り、文で答える問いは 係01〜係06 まで
  expect(await rowKeys()).toEqual(['row-row-10', 'row-' + SELF, 'row-row-12', 'row-row-11', 'row-row-01', 'row-row-02', 'row-row-03', 'row-row-04', 'row-row-05', 'row-row-06'])
  // ボタンには数だけを書き、たたんだ行の名前は、ボタンの外に黒い字で出す。
  // 枠線だけのボタン（dimColor）は、VS Code で中の字が灰色になるので使わない（11/15 の指示「灰色の文字のフォントはやめて下さい全部ですね」）
  const more = await ui.find({ type: 'Button', key: 'more' })
  expect(more?.props.label).toBe('ほか3を開く')
  expect(more?.props.dimColor).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '（係07、係08、係09）' }))?.props.color).toBe('#000000')
  // 押すと全部の行が出て、ボタンは「たたむ」になり、名前は出さない
  await ui.press({ key: 'more' })
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect((await rowKeys()).length).toBe(13)
  expect((await ui.find({ type: 'Button', key: 'more' }))?.props.label).toBe('たたむ')
  expect(await ui.find({ type: 'Text', text: '（係07、係08、係09）' })).toBeUndefined()
  // もう一度押すと、入る分だけに戻る
  await ui.press({ key: 'more' })
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect((await rowKeys()).length).toBe(10)
  await ui.unmount()

  // 入りきるときは、ボタンを出さない（ペインの行数が多いとき）
  const TALL = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 40 } } } as const
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...TALL })
  expect((await rowKeys()).length).toBe(13)
  expect(await ui.find({ type: 'Button', key: 'more' })).toBeUndefined()
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
    // 「お返事待ち」で止まった答えも、返事待ちとして出す（11/14。「〜ですか」が無くても隠さない）
    { id: 'gggg7777-gggg', name: '待ち', status: '待機中', compactions: 0, bytes: 1, answer: '調べました。\n**お返事待ちです。**型番を教えてください。', summary: '待ちの報告' },
    // このセッションは、待機中で返事を待っていなくても出す
    { id: SELF, name: '監視係', status: '待機中', compactions: 0, bytes: 1, answer: '', summary: '監視係の報告' },
  ]
  stubWorld(on, () => ran(JSON.stringify({ rows: someRows, cache: {} })))
  await $.session.start(START)
  await clock.advance(10_000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  for (const text of ['監視係', '働き', '確かめ', '問い', '待ち']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  for (const text of ['休み1', '休み2']) {
    expect(await ui.find({ type: 'Text', text })).toBeUndefined()
  }
  // 出さなかった数は、表の下に出さない（11/14 の指示「この下に表示されているのはもう表示しなくていいです」）
  expect(await ui.find({ type: 'Text', text: /表に出していません/ })).toBeUndefined()
  await ui.unmount()
})

test('各セッションの最後の答えを AI が1文に要約し、要約の列に出す。同じ答えは1回だけ要約する', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // AI は、見出しの頭に「完了：」か「途中：」を付けて返す（11/15）。頭の語は外して、見出しだけを出す。
  // セッションA の要約は、指示に反して、頭に【状態】、終わりに「、状態」と句点を付けて返る。見出しなので、どれも外して出す。
  // セッションC の要約は、ルールの名前の【 】で始まる。状態の語ではないので、頭の【 】は残し、終わりの「、完了」だけを外す。
  // ほかの要約は、頭の語が無いまま返る。全体を見出しとして出す
  const world = stubWorld(on, () => ran(JSON.stringify({ rows: rows(), cache: {} })), prompt =>
    prompt.includes('見出しの直し') ? '途中：【g 待ち】AI要約A、g 待ち。' : prompt.includes('表を直しました') ? '完了：【見た目】の直し、完了' : 'AI要約S')
  await $.session.start(START)
  for (let i = 0; i < 8; i++) await clock.advance(10_000)

  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  for (const text of ['AI要約A', '【見た目】の直し', 'AI要約S']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  // 要約は、表の1行に収まる全角20字以内の見出しで、何の作業かだけを書かせる（11/14 の指示「一行で分かるように」）。
  // 今の状態は書かせない。状態は、表が【 】で囲んで見出しの前に出す（11/15 の指示）
  expect(world.systems.every(system => system.includes('全角20字以内の見出し') && system.includes('は書かない。状態は、表が見出しの前に別に出す'))).toBe(true)
  // 見出しの頭に、完了か途中かを付けさせる。迷うときは途中にさせる（11/15）
  expect(world.systems.every(system => system.includes('「完了：見出し」か「途中：見出し」') && system.includes('どちらか迷うときは、途中にする'))).toBe(true)
  // 題名は、AI の要約に置き換わる
  expect(await ui.find({ type: 'Text', text: '見出しの直し（2点）' })).toBeUndefined()
  expect(world.prompts.length).toBe(4)
  // セッションC は、AI が完了と返しても、確認待ちなので【確】のまま（表が決める状態を、AI の判断より先に見る）
  expect(await ui.find({ type: 'Text', text: '【完】' })).toBeUndefined()
  await ui.unmount()
})

test('AI が作業を一区切り終えた報告と判断した行は、状態を【完】にし、全部たたむ。開くと、灰色の背景で一番下に並ぶ', async ($, on) => {
  // 11/15 の指示「チャットの回答の意味合いから、一旦作業が完了している場合は、完了というステータスにしてください」「完了の場合は灰色かな」。
  // 完了かどうかは、要約を作る AI が、見出しの頭に「完了：」か「途中：」を付けて返す。確認待ち、作業中、g 待ちは、AI の判断より先に表が決める。
  // 完了の行は、ペインに入るときも、全部たたむ（同じ日の指示「できれば、完成したものは全部畳んで欲しい」）。このセッションの行は、完了でもたたまない
  const clock = mock.clock(on, { now: NOW })
  const END = '修正が終わりました。\nお返事待ちです。次の作業があれば教えてください。'
  const doneRows = [
    { id: 'aaaa1111-aaaa', name: '甲', status: '待機中', compactions: 0, bytes: 1, answer: END, summary: '甲の題名' },
    { id: 'cccc3333-cccc', name: '乙', status: '待機中', compactions: 0, bytes: 1, answer: '調べました。\nお返事待ちです。型番を教えてください。', summary: '乙の題名' },
    { id: 'dddd4444-dddd', name: '丙', status: '待機中', compactions: 0, bytes: 1, answer: '修正が終わりました。\nお返事待ちです。この形でよければ g を押してください。', summary: '丙の題名' },
    { id: 'eeee5555-eeee', name: '丁', status: '作業中', compactions: 0, bytes: 1, answer: END, summary: '丁の題名' },
    { id: 'ffff6666-ffff', name: '戊', status: '待機中', compactions: 0, bytes: 1, answer: END + '（戊）', summary: '戊の題名' },
    { id: 'gggg7777-gggg', name: '己', status: '待機中', compactions: 0, bytes: 1, answer: END + '（己）', summary: '己の題名' },
    { id: SELF, name: '監視係', status: '待機中', compactions: 0, bytes: 1, answer: END + '（監視係）', summary: '監視係の題名' },
  ]
  // AI は、甲、丙、丁、監視係 を完了、乙 を途中と返す。丁 は、半角のコロンで返す。戊 は、要約に失敗する。己 は、頭の語を付けずに返す
  stubWorld(on, () => ran(JSON.stringify({ rows: doneRows, cache: {} })), prompt => {
    if (prompt.includes('乙の題名')) return '途中：乙の作業'
    if (prompt.includes('丁の題名')) return '完了: 丁の作業'
    if (prompt.includes('戊の題名')) return null
    if (prompt.includes('己の題名')) return '己の作業'
    if (prompt.includes('監視係の題名')) return '完了：監視係の作業'
    return '完了：' + (prompt.includes('甲の題名') ? '甲' : '丙') + 'の作業'
  })
  await $.session.start(START)
  for (let i = 0; i < 12; i++) await clock.advance(10_000)

  let ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  let texts = (await ui.findAll({ type: 'Text' })).map(found => String(found.text))
  // 完了の 甲 は、ペインに入る行数（7行）でも、たたんで出さない。見出しの行に「ほか1を開く」と、たたんだ行の名前が出る
  expect(await ui.find({ type: 'Box', key: 'row-aaaa1111-aaaa' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'more' }))?.props.label).toBe('ほか1を開く')
  expect(texts).toContain('（甲）')
  // このセッションの行は、完了でもたたまない。【完】が付き、背景は薄い橙のまま
  expect(texts.filter(text => /^【.*】$/.test(text))).toEqual(['【g】', '【完】', '【作】', '【返】', '【返】', '【返】'])
  expect((await ui.find({ type: 'Box', key: 'row-' + SELF }))?.props.backgroundColor).toBe('#ffe4c4')
  expect((await ui.findAll({ type: 'Box' })).filter(found => found.props.backgroundColor === '#e0e0e0')).toEqual([])
  // 開くと、全部の行が出る
  await ui.press({ key: 'more' })
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect((await ui.find({ type: 'Button', key: 'more' }))?.props.label).toBe('たたむ')
  texts = (await ui.findAll({ type: 'Text' })).map(found => String(found.text))
  // 上から、丙（g 待ち。AI が完了と返しても、g を求めているので g 待ち）、監視係、丁（作業中）、乙、戊、己（返事待ち）、甲（完了）
  const order = ['丙', '監視係', '丁', '乙', '戊', '己', '甲'].map(name => texts.indexOf(name))
  expect(order.every(at => at >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  // 状態の字。完了は 監視係 と 甲。要約に失敗した 戊 と、頭の語が無い 己 は、返事待ちのまま（完了と取り違えない）
  expect(texts.filter(text => /^【.*】$/.test(text))).toEqual(['【g】', '【完】', '【作】', '【返】', '【返】', '【返】', '【完】'])
  const label = (await ui.findAll({ type: 'Text', text: '【完】' })).at(-1)
  expect(label?.props.bold).toBe(true)
  expect(label?.props.color).toBe('#000000')
  // 完了の行は、問いで終わっていても、薄い黄色ではなく灰色。字は黒のまま
  expect((await ui.find({ type: 'Box', key: 'row-aaaa1111-aaaa' }))?.props.backgroundColor).toBe('#e0e0e0')
  const fills = (await ui.findAll({ type: 'Box' })).map(found => found.props.backgroundColor)
  expect(fills.filter(color => color === '#e0e0e0').length).toBe(1)
  // 薄い黄色は、丙、乙、戊、己 の4行
  expect(fills.filter(color => color === '#fff3c4').length).toBe(4)
  for (const text of ['甲', '甲の作業']) {
    expect((await ui.find({ type: 'Text', text }))?.props.color).toBe('#000000')
  }
  // 頭の語は外して、見出しだけを出す。半角のコロンでも外す
  for (const text of ['甲の作業', '乙の作業', '丙の作業', '丁の作業', '己の作業']) {
    expect(texts).toContain(text)
  }
  // 要約に失敗した 戊 は、題名のまま
  expect(texts).toContain('戊の題名')
  await ui.unmount()
})

test('状態は先頭の1文字を【 】で囲んで要約の先頭に黒い太字で出し、待機中で返事を待っていない行には付けない', async ($, on) => {
  // 11/15 の指示「ステータスは強調できるように、黒枠のかっこで囲むようにしてください」「先頭につけた方が良いかもしれないね」。
  // 種類は4つ（確認待ち、g 待ち、返事待ち、作業中）で、表が自分で決める。
  // 出すのは先頭の1文字（確、g、返、作。同じ日の指示「括弧の中身は一文字で十分です。幅を取らないで欲しいです」）
  const clock = mock.clock(on, { now: NOW })
  const stateRows = [
    { id: 'aaaa1111-aaaa', name: '甲', status: '作業中', compactions: 0, bytes: 1, answer: 'お返事待ちです。よければ g を押してください。', summary: '甲の報告' },
    { id: 'cccc3333-cccc', name: '乙', status: '待機中', compactions: 0, bytes: 1, answer: '表を直しました。これでよいですか。', summary: '乙の報告' },
    { id: 'dddd4444-dddd', name: '丙', status: '待機中', compactions: 0, bytes: 1, answer: 'お返事待ちです。この形でよければ g を押してください。', summary: '丙の報告' },
    { id: 'eeee5555-eeee', name: '丁', status: '確認待ち', compactions: 0, bytes: 1, answer: 'お返事待ちです。よければ g を押してください。', summary: '丁の報告' },
    // このセッションは、待機中で返事を待っていない
    { id: SELF, name: '監視係', status: '待機中', compactions: 0, bytes: 1, answer: '', summary: '監視係の報告' },
  ]
  stubWorld(on, () => ran(JSON.stringify({ rows: stateRows, cache: {} })))
  const { sent } = stubSend(on)
  await $.session.start(START)
  await clock.advance(10_000)

  let ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const labelsOf = async () => (await ui.findAll({ type: 'Text', text: /^【.*】$/ })).map(found => String(found.text))
  // 上から、丙（g 待ち）、監視係（付けない）、丁（確認待ち。g を求める答えより、確認待ちを先に見る）、甲（作業中。g を求める答えでも作業中）、乙（返事待ち）
  expect(await labelsOf()).toEqual(['【g】', '【確】', '【作】', '【返】'])
  // 黒い太字で、要約の左に置く
  for (const found of await ui.findAll({ type: 'Text', text: /^【.*】$/ })) {
    expect(found.props.bold).toBe(true)
    expect(found.props.color).toBe('#000000')
  }
  // どの行にも、状態の欄（同じ幅の箱）がある。幅は全角3字の6桁。状態は、その行の名前より後ろ、要約より前に出る
  for (const id of stateRows.map(row => row.id)) {
    expect((await ui.find({ type: 'Box', key: id + '-state' }))?.props.width).toBe(6)
  }
  const texts = (await ui.findAll({ type: 'Text' })).map(found => String(found.text))
  expect(texts.indexOf('丙')).toBeLessThan(texts.indexOf('【g】'))
  expect(texts.indexOf('【g】')).toBeLessThan(texts.indexOf('丙の報告'))
  // AI の要約ができていなくても（題名のままでも）、状態は出る
  expect(texts).toContain('丙の報告')

  // g を押したあと、相手が作業を始めるまでのあいだは、その行に何も付けない（g は送ったので、返事待ちではない）
  await ui.press({ key: 'g-dddd4444-dddd' })
  await clock.advance(100)
  expect(sent.length).toBe(1)
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await labelsOf()).toEqual(['【確】', '【作】', '【返】'])
  await ui.unmount()
})

test('要約と名前は黒い字の文で出し、灰色の字になる枠線だけのボタンは使わない。g と開のボタンはふつうのボタンにする', async ($, on) => {
  // 11/15 の指示「灰色の文字のフォントはやめて下さい全部ですね。黒の濃い字にして下さい」「要約のところの説明文が薄い灰色の文字になっています」。
  // VS Code は、押せるボタンの中の字を、枠線だけのボタン（dimColor）では灰色、ふつうのボタンでは青地に白に決め、mod からは黒にできない。
  // そこで要約はボタンの外の文にし、色は mod が決める
  const clock = mock.clock(on, { now: NOW })
  // 5行目は、状態がどれにも当たらず、返事も待っていない行（背景に色が無い行）
  const plain = { id: 'ffff6666-ffff', name: '色なし', status: '不明', compactions: 0, bytes: 1, answer: '', summary: '色なしの報告', entrypoint: 'cli' }
  stubWorld(on, () => ran(JSON.stringify({ rows: [...rows(), plain], cache: {} })))
  await $.session.start(START)
  await clock.advance(10_000)
  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const buttons = await ui.findAll({ type: 'Button' })
  // 要約のボタンは無く、枠線だけのボタン（dimColor）は1つも無い
  expect(buttons.filter(found => String(found.props.key).startsWith('summary-'))).toEqual([])
  expect(buttons.filter(found => found.props.dimColor === true)).toEqual([])
  // 背景に色がある行（このセッション、返事待ち、作業中）は、名前も要約も黒（#000000）。要約に背景の色は付けない
  for (const text of ['監視係', 'セッションA', 'セッションC', 'セッションD', '見出しの直し（2点）', '表を直しました。', '見出しの整え方（3点）', '長い報告']) {
    const found = await ui.find({ type: 'Text', text })
    expect(found?.props.color).toBe('#000000')
    expect(found?.props.backgroundColor).toBeUndefined()
    expect(found?.props.dimColor).toBeUndefined()
  }
  // 背景に色が無い行は、画面の側の字の色のまま（暗い背景の画面で、黒い字が読めなくなるため）
  for (const text of ['色なし', '色なしの報告']) {
    const found = await ui.find({ type: 'Text', text })
    expect(found).toBeDefined()
    expect(found?.props.color).toBeUndefined()
  }
  // g と開のボタンは、VS Code のふつうのボタン（テーマの青地に白い字）。g は セッションA と 監視係 の2行、開は5行
  const others = buttons.filter(found => /^(open|g)-/.test(String(found.props.key)))
  expect(others.length).toBe(7)
  expect(others.every(found => found.props.dimColor === undefined)).toBe(true)
  await ui.unmount()
})

test('作業中の行は薄い青になり、見出しの行の水色とは別の色になる', async ($, on) => {
  // 11/14 の指示「今活動中のセッションはちょっと色が付いた方がいい」。作業中は セッションD だけ
  await started($, on)
  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const fills = (await ui.findAll({ type: 'Box' })).map(found => found.props.backgroundColor)
  expect(fills.filter(color => color === '#d9eefa').length).toBe(1)
  expect(fills.filter(color => color === '#eaf6fc').length).toBe(1)
  // 返事を待っている セッションA と セッションC は薄い黄色のまま
  expect(fills.filter(color => color === '#fff3c4').length).toBe(2)
  await ui.unmount()
})

test('このセッションの行は、作業中でも薄い青にせず、薄い橙のままにする', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const working = rows().map(row => (row.id === SELF ? { ...row, status: '作業中' } : row))
  stubWorld(on, () => ran(JSON.stringify({ rows: working, cache: {} })))
  await $.session.start(START)
  await clock.advance(10_000)
  const ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  const fills = (await ui.findAll({ type: 'Box' })).map(found => found.props.backgroundColor)
  expect(fills.filter(color => color === '#ffe4c4').length).toBe(1)
  // 薄い青は セッションD の1行だけ（このセッションの行は数えない）
  expect(fills.filter(color => color === '#d9eefa').length).toBe(1)
  await ui.unmount()
})

test('横に置かれて幅が狭いとき（dock で78桁未満）は、1セッションを2行で描き、要約を名前の下の行に出す', async ($, on) => {
  // 11/14 の指示「フレームを広げると横表示になってしまいますね」「下に表示しないと説明文要約文が見れないです」。
  // VS Code は、画面の幅が 800px 以上だとペインを横に置く。横は幅が狭く、1行のままだと要約が数文字で切れる
  await started($, on)
  const DOCK = { ...PANE, props: { ...PANE.props, placement: 'dock', bodyColumns: 44 } } as const
  let ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...DOCK })
  // 1行目（名前、進、開）の箱と、その下の状態と要約の箱が、どの行にもある
  for (const id of ['aaaa1111-aaaa', 'cccc3333-cccc', 'dddd4444-dddd', SELF]) {
    expect(await ui.find({ type: 'Box', key: id + '-top' })).toBeDefined()
    expect(await ui.find({ type: 'Box', key: id + '-open' })).toBeDefined()
    expect(await ui.find({ type: 'Box', key: id + '-message' })).toBeDefined()
    expect(await ui.find({ type: 'Box', key: id + '-state' })).toBeDefined()
  }
  // 要約は名前の下の行に出るので、見出しの行に「要約」は置かない。名前、進、開は置く
  expect(await ui.find({ type: 'Text', text: '要約' })).toBeUndefined()
  for (const text of ['名前', '進', /^開$/, '見出しの直し（2点）']) {
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  }
  // 横でも、状態は先頭の1文字を【 】で囲んで要約の前に出る。上から 監視係 と セッションA（g 待ち）、セッションC（確認待ち）、セッションD（作業中）
  const labels = (await ui.findAll({ type: 'Text', text: /^【.*】$/ })).map(found => String(found.text))
  expect(labels).toEqual(['【g】', '【g】', '【確】', '【作】'])
  await ui.unmount()

  // 入力欄の上に置かれたとき（inline）は、今までどおり1行で、2行用の箱は無い
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...PANE })
  expect(await ui.find({ type: 'Box', key: 'aaaa1111-aaaa-top' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '要約' })).toBeDefined()
  await ui.unmount()

  // 横でも、ペインの幅が広くて要約が1行に収まるとき（78桁以上）は、1行のままにする。
  // 2行にすると行の数が倍になり、セッションが多いと縦のスクロールが出るため
  const WIDE = { ...PANE, props: { ...PANE.props, placement: 'dock', bodyColumns: 90 } } as const
  ui = await $.ui.mount({ plugin: 'session-list', surface: 'vscode', ...WIDE })
  expect(await ui.find({ type: 'Box', key: 'aaaa1111-aaaa-top' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '要約' })).toBeDefined()
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
