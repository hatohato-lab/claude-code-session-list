// ペインの中身を描く。1セッション＝1行の表で、見出しの行を付ける
// 列は左から、チームの線、チームの ■、名前（左に状態の色の丸）、進（g）、開く（タブを前に出し、ID をコピー）、要約（最後の報告の要約。押すと行の下に終わり600字）
// 10/18、2行や4行のカードにすると分かりづらいとの指示で1行の表に戻した。要約は指示で一番右に置き、字を小さくした
// 10/31、詳しくの列を消し、列名を 進・送・要約 に縮めた（私の指示「詳しくというボタンは使用頻度が非常に低い」「一文字でいい」）
// 11/08、状態の列を名前の左の色の丸にし、ID の列を消して開くで写すようにした（私の指示「一列とるのはもったいないので、名前の所に丸いアイコン」
// 「開くボタンを押したら自動的にクリップボードに入るように」）。要約に載せたときの箱は、表の幅いっぱいで600字にした
// 11/08、待機中で返事を待っていない行（背景が白い行）は出さず、隠した数を表の下に出すことにした（私の指示「表示する必要がない」）
// 11/08、マウスを載せる箱は VS Code で出なかったので、要約を押すと行の下に開く形にした（私の指示「クリックしたら下の方に詳細が出てくる」）。
// 送（入力ボックス）の列は外した（私の指示「送信の列もいらないです。使わないことがわかりました」）
// チーム（名前の数字を除いた部分が同じセッションが2つ以上）は続けて並べ、左に同じ色の線と ■ を付ける。
// チームの中では、主（直近3時間にチームへ一番多く連絡を出したセッション）を先頭にし、ほかには「└」を付ける。
// チームの先頭の名前を押すと、そのチームの最近のやり取りが、チームの下に開く
// 返事を待っている行は薄い黄色、このセッションの行は薄い橙
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { Inbox, SessionRow, Summary } from '../../types'
import { BLACK, BLUE, EMPTY, GREEN, HEAD_FILL, RED, SELF_FILL, fitCells, live, normalize } from './共通'
import { openRow } from './タブを前に出す'
import { asksG, findAsk, pressG, readNote } from './文を送る'
import { messageOf, tailOf } from './要約する'

const snapshot = atom({ plugin: 'session-list', key: 'snapshot' } as const, EMPTY)
const sendNote = atom({ plugin: 'session-list', key: 'sendNote' } as const, '')
// やり取りを開いているチーム（チームの名前）
const openTeams = atom({ plugin: 'session-list', key: 'openTeams' } as const, [] as string[])
// 要約を押して、行の下に最後の報告の終わりを開いているセッション（セッションID）
const openTails = atom({ plugin: 'session-list', key: 'openTails' } as const, [] as string[])
// AI の要約（メッセージの列に出す）
const summaries = atom({ plugin: 'session-list', key: 'summaries' } as const, {} as Record<string, Summary>)

// 列の幅（桁。全角1字は2桁）。メッセージの列は、ほかの列を置いた残りの幅を全部使い、1行に収める（入りきらない分は右端で「…」）
// 名前の列は、左の2桁に状態の丸を置き、残りの14桁に名前を書く
const NAME_CELLS = 16
const DOT_CELLS = 2
const BUTTON_CELLS = 5
// 送（入力ボックス）の列は、11/08 の指示で無くした
// 開くのボタンの列（押すと、ID の全体がクリップボードに入り、そのセッションのタブが VS Code の一番前に出る。10/18 と 11/08 の指示）。
// ID の列（10/24 の指示）は、11/08 の指示で無くした
const OPEN_CELLS = 5

// チームの色。チームごとに、左の線と ■ をこの色にする
const TEAM_COLORS = ['#2e7d32', '#1565c0', '#6a1b9a', '#ef6c00', '#00838f']
const NO_NAME = '（名前なし）'
// 返事を待っている行の色
const WAIT_FILL = '#fff3c4'
// 要約を押したときに行の下に開く欄の、枠の色
const CARD_BORDER = '#999999'
// 主を決めるときに数える連絡の範囲（直近3時間）と、開いたやり取りに出す件数
const LEAD_WINDOW_MS = 3 * 60 * 60 * 1000
const TALK_SHOWN = 8

// 状態の丸（11/08 の指示）。作業中は青、確認待ちは赤、待機中は緑の ●。ほかの値は黒い ○
function statusDot(status: string): { mark: string; color: string } {
  if (status === '作業中') return { mark: '●', color: BLUE }
  if (status === '確認待ち') return { mark: '●', color: RED }
  if (status === '待機中') return { mark: '●', color: GREEN }
  return { mark: '○', color: BLACK }
}

// 私の返事を待っているか。確認待ちか、最後の答えで g を求めているか、「〜ですか」「〜ますか」と聞いている。
// 「次の指示をお願いします」のように、何も聞いていない待ち方は含めない
function isWaiting(row: SessionRow): boolean {
  if (row.status === '作業中') return false
  if (row.status === '確認待ち' || asksG(row)) return true
  return /ですか|ますか|[？?]/.test(findAsk(row.answer ?? ''))
}

// 表に出す行か（11/08 の指示「活動していないセッションは表示する必要がない」）。
// 待機中で、私の返事を待っていない行（背景が白い行）は出さない。このセッションの行は、いつも出す。
// チームは、出す行だけで決める（隠れた仲間しかいないセッションは、チームの印を付けない）
function isShown(row: SessionRow): boolean {
  return row.id === live.selfId || row.status !== '待機中' || isWaiting(row)
}

// 名前の末尾の数字を除いた部分。2つ以上のセッションが同じなら、同じチーム（例：作業1・作業2・作業3 は「作業」）
function teamKey(name: string): string {
  return name === NO_NAME ? '' : name.replace(/[\s0-9０-９]+$/u, '').trim()
}

function isInbox(value: unknown): value is Inbox {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.from === 'string' && typeof item.text === 'string' && typeof item.at === 'number'
}

type Talk = { at: number; from: SessionRow; to: SessionRow; text: string }

// チームのやり取り（チームの中のセッションから、チームの中のセッションへ届いた連絡）。新しい順。within が数なら、その範囲だけ
function teamTalk(rows: SessionRow[], now: number, within: number | null): Talk[] {
  const byAddress = new Map<string, SessionRow>()
  for (const row of rows) if (row.address !== undefined && row.address !== '') byAddress.set(row.address, row)
  const talk: Talk[] = []
  for (const to of rows) {
    for (const item of to.inbox ?? []) {
      if (!isInbox(item)) continue
      const from = byAddress.get(item.from)
      if (from === undefined || from.id === to.id) continue
      if (within !== null && now - item.at > within) continue
      talk.push({ at: item.at, from, to, text: item.text })
    }
  }
  return talk.sort((a, b) => b.at - a.at)
}

// 主。直近3時間にチームへ一番多く連絡を出したセッション（同じ数なら、最後に出した方）。連絡が無ければ主は無い
function leaderOf(rows: SessionRow[], now: number): string | null {
  const counts = new Map<string, { n: number; last: number }>()
  for (const one of teamTalk(rows, now, LEAD_WINDOW_MS)) {
    const before = counts.get(one.from.id) ?? { n: 0, last: 0 }
    counts.set(one.from.id, { n: before.n + 1, last: Math.max(before.last, one.at) })
  }
  let best: string | null = null
  let bestN = 0
  let bestLast = 0
  for (const [id, c] of counts) {
    if (c.n > bestN || (c.n === bestN && c.last > bestLast)) {
      best = id
      bestN = c.n
      bestLast = c.last
    }
  }
  return best
}

type Group = { key: string; color: string | undefined; lead: string | null; rows: SessionRow[] }

// 並べ方。このセッションのチーム（チームが無ければこのセッションだけ）を一番上に置き、ほかのチームを続け、最後にチームの無いセッション。
// チームの中は、主、このセッション、返事を待っている行の順で、あとはセッション表.py の並び（名前の順）のまま
function arrange(rows: SessionRow[], self: string, now: number): Group[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = teamKey(row.name)
    if (key !== '') counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const isTeam = (key: string) => key !== '' && (counts.get(key) ?? 0) >= 2
  const rank = (row: SessionRow) => (row.id === self ? 0 : isWaiting(row) ? 1 : 2)
  const selfRow = rows.find(row => row.id === self)
  const selfKey = selfRow === undefined ? '' : teamKey(selfRow.name)
  const teams = [...counts.keys()].filter(isTeam).sort((a, b) => (a === selfKey ? -1 : b === selfKey ? 1 : a.localeCompare(b)))
  const groups: Group[] = []
  const placed = new Set<string>()
  if (selfRow !== undefined && !isTeam(selfKey)) {
    groups.push({ key: '', color: undefined, lead: null, rows: [selfRow] })
    placed.add(selfRow.id)
  }
  teams.forEach((key, i) => {
    const members = rows.filter(row => teamKey(row.name) === key)
    const lead = leaderOf(members, now)
    const order = (row: SessionRow) => (row.id === lead ? -1 : rank(row))
    for (const row of members) placed.add(row.id)
    groups.push({ key, color: TEAM_COLORS[i % TEAM_COLORS.length], lead, rows: members.sort((a, b) => order(a) - order(b)) })
  })
  for (const row of rows.filter(one => !placed.has(one.id)).sort((a, b) => rank(a) - rank(b))) {
    groups.push({ key: '', color: undefined, lead: null, rows: [row] })
  }
  return groups
}

function hhmm(at: number): string {
  const d = new Date(at)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

export async function drawPane($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const table = $.ui.resolve(e)
  const { Box, Text, Button } = table
  const snap = normalize(await read($, snapshot))
  const now = await $.clock.now()
  const shown = snap.rows.filter(isShown)
  const hiddenCount = snap.rows.length - shown.length
  const groups = arrange(shown, live.selfId, now)
  const note = readNote(await read($, sendNote))
  const storedOpen = await read($, openTeams)
  const open = Array.isArray(storedOpen) ? storedOpen : []
  const storedTails = await read($, openTails)
  const tails = Array.isArray(storedTails) ? storedTails : []
  const storedSummaries = await read($, summaries)
  if (snap.rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={snap.error === null ? undefined : RED}>{snap.error ?? 'セッションの情報を読み込んでいます'}</Text>
      </Box>
    )
  }

  const toggle = (key: string) =>
    update($, openTeams, list => {
      const current = Array.isArray(list) ? list : []
      return current.includes(key) ? current.filter(one => one !== key) : [...current, key]
    })

  // 要約を押すたびに、その行の下の欄を開け閉めする
  const toggleTail = (id: string) =>
    update($, openTails, list => {
      const current = Array.isArray(list) ? list : []
      return current.includes(id) ? current.filter(one => one !== id) : [...current, id]
    })

  const drawRow = (group: Group, row: SessionRow, index: number) => {
    const isSelf = row.id === live.selfId
    const textColor = isSelf ? BLACK : undefined
    const dot = statusDot(row.status)
    const prefix = group.key === '' || group.lead === null ? '' : row.id === group.lead ? '主 ' : '└ '
    const label = fitCells(prefix + row.name, NAME_CELLS - DOT_CELLS)
    // 要約の欄は押せる文にする。押すと、行のすぐ下に最後の答えの終わり600字が開く（drawTail）。要約の文を切るのは内側の箱だけにする
    return (
      <Box key={'row-' + row.id} flexDirection="row" flexWrap="nowrap" gap={1} alignItems="stretch" backgroundColor={isSelf ? SELF_FILL : isWaiting(row) ? WAIT_FILL : undefined}>
        <Box key={row.id + '-bar'} width={1} flexShrink={0} backgroundColor={group.color}>
          <Text> </Text>
        </Box>
        <Box key={row.id + '-mark'} width={2} flexShrink={0} flexDirection="column" justifyContent="center">
          <Text color={group.color}>{group.color === undefined ? ' ' : '■'}</Text>
        </Box>
        <Box key={row.id + '-name'} width={NAME_CELLS} flexShrink={0} flexDirection="row" alignItems="center">
          <Box width={DOT_CELLS} flexShrink={0}>
            <Text color={dot.color}>{dot.mark}</Text>
          </Box>
          {group.key !== '' && index === 0 ? (
            <Button key={'team-' + group.key} plain onPress={() => void toggle(group.key)}>
              <Text color={textColor}>{label}</Text>
            </Button>
          ) : (
            <Text color={textColor}>{label}</Text>
          )}
        </Box>
        <Box key={row.id + '-button'} width={BUTTON_CELLS} flexShrink={0} flexDirection="column" justifyContent="center" alignItems="center">
          {asksG(row) && <Button key={'g-' + row.id} label="g" onPress={() => void pressG($, row)} />}
        </Box>
        <Box key={row.id + '-open'} width={OPEN_CELLS} flexShrink={0} flexDirection="column" justifyContent="center" alignItems="center">
          <Button key={'open-' + row.id} label="開" onPress={press => void openRow($, row, press.surface)} />
        </Box>
        <Box key={row.id + '-message'} flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column" justifyContent="center">
          <Box minWidth={0} overflow="hidden">
            <Button key={'tail-' + row.id} plain onPress={() => void toggleTail(row.id)}>
              <Text color={textColor} size="caption" wrap="truncate-end">{messageOf(row, storedSummaries)}</Text>
            </Button>
          </Box>
        </Box>
      </Box>
    )
  }

  // 要約を押した行の下に開く欄。最後の答えの終わり600字（答えが無ければ、そのことを1行で出す）
  const drawTail = (row: SessionRow) => {
    const tail = tailOf(row.answer ?? '')
    return (
      <Box key={'tail-box-' + row.id} flexDirection="column" borderStyle="single" borderColor={CARD_BORDER} paddingX={1}>
        <Text color={BLACK}>{tail !== '' ? tail : row.name + ' の最後の報告は、まだありません'}</Text>
      </Box>
    )
  }

  // チームの最近のやり取り（新しい順に8件まで）。時刻、送り主 → 受け手、本文の頭
  const drawTalk = (group: Group) => {
    const talk = teamTalk(group.rows, now, null).slice(0, TALK_SHOWN)
    return (
      <Box key={'talk-' + group.key} flexDirection="column" paddingLeft={4}>
        {talk.length === 0 ? (
          <Text color={BLACK} size="caption">このチームのやり取りは、まだありません</Text>
        ) : (
          talk.map((one, i) => (
            <Text key={'talk-' + group.key + '-' + String(i)} color={BLACK} size="caption" wrap="truncate-end">
              {hhmm(one.at) + '  ' + one.from.name + ' → ' + one.to.name + '  ' + one.text.replace(/\s+/g, ' ')}
            </Text>
          ))
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="nowrap" gap={1} backgroundColor={HEAD_FILL}>
        <Box key="head-bar" width={1} flexShrink={0}>
          <Text> </Text>
        </Box>
        <Box key="head-mark" width={2} flexShrink={0}>
          <Text> </Text>
        </Box>
        <Box key="head-name" width={NAME_CELLS} flexShrink={0}>
          <Text bold color={BLACK}>名前</Text>
        </Box>
        <Box key="head-button" width={BUTTON_CELLS} flexShrink={0} justifyContent="center">
          <Text bold color={BLACK}>進</Text>
        </Box>
        <Box key="head-open" width={OPEN_CELLS} flexShrink={0} justifyContent="center">
          <Text bold color={BLACK}>開く</Text>
        </Box>
        <Box key="head-message" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text bold color={BLACK}>要約</Text>
        </Box>
      </Box>
      {groups.map(group => (
        <Box key={'group-' + (group.key !== '' ? group.key : group.rows[0]?.id ?? '')} flexDirection="column">
          {group.rows.flatMap((row, index) => (tails.includes(row.id) ? [drawRow(group, row, index), drawTail(row)] : [drawRow(group, row, index)]))}
          {group.key !== '' && open.includes(group.key) && drawTalk(group)}
        </Box>
      ))}
      {hiddenCount > 0 && <Text color={BLACK}>{'待機中で返事を待っていない' + String(hiddenCount) + 'セッションは、表に出していません'}</Text>}
      {snap.error !== null && <Text color={RED}>{snap.error}</Text>}
      {note !== null && <Text color={BLACK}>{note.text}</Text>}
    </Box>
  )
}
