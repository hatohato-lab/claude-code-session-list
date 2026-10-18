import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { Activity, Entry, FeedItem, Link, SessionRow, Snapshot, TalkItem } from '../types'

// ペインの名前（id は英数字だけ。題名は日本語でよい）
const PANE = 'session-list'
// 版。/sessions の出力と起動記録.txt に出し、画面が新しい中身になったかを確かめるのに使う（0.7.13 で元の縦の図に戻した）
const VERSION = '0.7.20'
const TITLE = 'セッション一覧'

// 生ログの大きさは2秒ごと、様子・やり取り（黒板と合図）は5秒ごと、在席表.py は15秒ごと
const SIZE_EVERY_MS = 2000
const FEED_EVERY_MS = 5000
const LIST_EVERY_MS = 15000
// この時間のうちにやり取りした相手を、名前の横に「⇄相手」で示す
const PARTNER_WINDOW_MS = 30 * 60 * 1000
const FEED_MAX = 20
// 会話の地図に描くやり取りの範囲
const LINK_WINDOW_MS = 24 * 60 * 60 * 1000
// この時間のうちのやり取りは、図の線を濃くする
const RECENT_LINK_MS = 60 * 60 * 1000
// 送った側と受けた側の記録は、同じ文面の印（key）で2分以内なら同じ合図。同じ組で90秒以内の重なりも1つにする
const PAIR_MS = 120 * 1000
const MERGE_MS = 90 * 1000
// 要約は、全体で20秒に1回まで、1つのセッションは3分に1回まで（使用量を抑える）
const SUMMARY_GAP_MS = 20 * 1000
const SUMMARY_EVERY_MS = 3 * 60 * 1000
// 道具を使ったまま、生ログがこの秒数以上止まっていたら「承認待ちかも」とみなす
const PERMISSION_QUIET_SEC = 20

// 材料の場所。在席表.py と合図表.py は MOD に同梱した tools にある（クローンしてすぐ動くように）。
// 黒板はワークスペースからの相対で、ワークスペースは設定の workspaceDir、空ならセッションの作業フォルダー。黒板のフォルダーが無ければ、黒板の部分は出さない
const ATTENDANCE_TOOL = '在席表.py'
const BELLS_TOOL = '合図表.py'
const BOARD_PARTS = ['00_黒板', 'Claude']

// 要約の頼み方
const SUMMARY_SYSTEM = [
  'あなたは、ある Claude Code のセッションの直近のやり取りを読み、そのセッションの AI がいま何をしていて、次に何をしようとしているかを、日本語2行で要約する係です。',
  '1行目は「いま:」で始め、取り組んでいることを40字以内で書く。',
  '2行目は「次:」で始め、次にすること、または止まっている理由（人の返事待ち・承認待ちなど）を40字以内で書く。',
  '前置き・敬語・箇条書きの記号は書かない。2行だけを返す。',
].join('\n')

// 色（意味を固定する。赤＝人の手が要る、青＝作業中、緑＝問題なし、黄の背景＝確かめていない注意）
const BLACK = '#000000'
const RED = '#c00000'
const BLUE = '#1f6fb2'
const GREEN = '#006400'
const CAUTION_BG = '#fff3c4'

const EMPTY: Snapshot = { rows: [], feed: [], feedNote: '', links: [], updatedAt: 0, error: null }
const snapshot = atom({ plugin: 'session-list', key: 'snapshot' } as const, EMPTY)

// 入力欄の送り先・直前の結果・送った回数
const SELF = 'self'
const target = atom({ plugin: 'session-list', key: 'target' } as const, SELF)
const sendNote = atom({ plugin: 'session-list', key: 'sendNote' } as const, '')
const sendCount = atom({ plugin: 'session-list', key: 'sendCount' } as const, 0)
const showMap = atom({ plugin: 'session-list', key: 'showMap' } as const, true)
const talk = atom({ plugin: 'session-list', key: 'talk' } as const, [] as TalkItem[])
const picked = atom({ plugin: 'session-list', key: 'picked' } as const, [] as string[])
// /sessions で開いたら true、使っている人が手で閉じたら false。読み直しで閉じたペインは、次の入力のついでに開き直す
const paneWanted = atom({ plugin: 'session-list', key: 'paneWanted' } as const, false)
// 並べて見るセッションの数と、1列に出す件数
const COLUMNS_MAX = 3
const ENTRIES_SHOWN = 6
// 返事の目印。相手には「【監視画面へ:相手のID】」を先頭に付けて返してもらう
const REPLY_MARK = '【監視画面へ'
const TALK_MAX = 10

type Listed = Pick<SessionRow, 'name' | 'id' | 'dest' | 'status' | 'since'>
type Bell = { stamp: number; from: string; to: string; via: string; key: string; text: string }
type RawActivity = Activity & { recent: string; recentKey: string }
type Tone = 'red' | 'caution' | 'blue' | 'plain'

// 読み込み直しで消えてよい控え
let home = ''
let workspace = ''
// 設定の senderName（他のセッションへ送る文の頭に付ける名前。空なら付けない）
let senderName = ''
// 設定の summaries（要約を作るか）と summaryModel（要約に使うモデル）
let isSummaryOn = true
// 設定の view。simple は図と入力欄だけ（既定）、detail は名簿・要約・やり取りの一覧も出す
let isSimple = true
let summaryModel = 'haiku'
let selfId = ''
let listed: Listed[] = []
const logPaths: Record<string, string> = {}
let boardItems: FeedItem[] = []
let bells: Bell[] = []
let bellOffsets: Record<string, number> = {}
let activities: Record<string, RawActivity> = {}
const summaries: Record<string, { key: string; text: string; at: number }> = {}
let isBusy = false
let isSummarizing = false
let lastSummaryCallAt = 0
let lastListAt = 0
let lastFeedAt = 0
let lastListError: string | null = null
let lastFeedError: string | null = null
// /sessions でペインを開いたセッションでだけ動く。全セッションで読み込まれるため、開いていないセッションでは何もしない。閉じたら止まる
let isPaneOpen = false
// 最後に記録したペインの大きさ（表示記録.txt を変わったときだけ書くため）
let lastDims = ''

function join(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

function hhmm(ms: number): string {
  const d = new Date(ms)
  return two(d.getHours()) + ':' + two(d.getMinutes())
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return String(d.getFullYear()) + two(d.getMonth() + 1) + two(d.getDate())
}

// 何分前かを短く言う
function ago(ms: number | null, now: number): string {
  if (ms === null) return ''
  const sec = Math.max(0, Math.round((now - ms) / 1000))
  if (sec < 60) return 'たった今'
  if (sec < 3600) return Math.floor(sec / 60) + '分前'
  return Math.floor(sec / 3600) + '時間前'
}

// 在席表.py の出力（名前 | ID | 宛先名 | 状態 | 時刻）を行ごとに読む
function parseAttendance(stdout: string): Listed[] {
  const rows: Listed[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const cells = line.split(' | ').map(cell => cell.trim())
    const name = cells[0]
    const id = cells[1]
    const dest = cells[2]
    const status = cells[3]
    const since = cells[4]
    if (cells.length !== 5 || name === undefined || id === undefined || dest === undefined || status === undefined || since === undefined) continue
    if (name === '名前' || !/^[0-9a-f]{8}$/.test(id)) continue
    rows.push({ name, id, dest, status, since })
  }
  return rows
}

// 黒板のファイル名「YYYYMMDD_HHMM_送り主→宛先_種類_件名（_既読）.md」を1行のやり取りにする
const BOARD_RE = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_(.+?)→(.+?)_(依頼|報告|連絡|回答|改善案|質問|返信|確認|相談|提案|通知|完了|お礼|指示)_(.+?)(_既読)?\.md$/
const BOARD_LOOSE_RE = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_(.+?)→([^_]+)_(.+?)(_既読)?\.md$/

function parseBoardName(name: string): FeedItem | null {
  const strict = BOARD_RE.exec(name)
  const m = strict ?? BOARD_LOOSE_RE.exec(name)
  if (m === null) return null
  const y = m[1]
  const mo = m[2]
  const d = m[3]
  const hh = m[4]
  const mm = m[5]
  const from = m[6]
  const to = m[7]
  if (y === undefined || mo === undefined || d === undefined || hh === undefined || mm === undefined || from === undefined || to === undefined) return null
  const kind = strict !== null ? (m[8] ?? '') : ''
  const subject = (strict !== null ? m[9] : m[8]) ?? ''
  const isRead = (strict !== null ? m[10] : m[9]) !== undefined
  const stamp = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm)).getTime()
  return { stamp, time: hh + ':' + mm, from, to, kind, subject, isUnread: !isRead }
}

// 全角の文字は2マス、それ以外は1マスとして表示幅を数える
function cellWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    width += isWide ? 2 : 1
  }
  return width
}

function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n))
}

// 先頭から表示幅 max までで切り、切ったら「…」を付ける
function cut(text: string, max: number): string {
  let out = ''
  let width = 0
  for (const ch of text) {
    const w = cellWidth(ch)
    if (width + w > max - 1) return out + '…'
    out += ch
    width += w
  }
  return out
}

function formatMb(bytes: number | null): string {
  if (bytes === null) return '?'
  return (bytes / 1048576).toFixed(1)
}

// 幅の狭い横棒（1マスを8つに割った文字で、少ないマスでも差が見える）
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
function miniBar(fraction: number, cells: number): string {
  const eighths = Math.max(1, Math.round(clamp(fraction, 0, 1) * cells * 8))
  return '█'.repeat(Math.floor(eighths / 8)) + (EIGHTHS[eighths % 8] ?? '')
}

function formatTime(ms: number): string {
  if (ms === 0) return '--:--:--'
  const d = new Date(ms)
  return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds())
}

function nameOf(id8: string): string {
  const row = listed.find(one => one.id === id8)
  return row === undefined ? id8 : row.name
}

function isLiveId(value: string): boolean {
  return listed.some(row => row.id === value)
}

// 状態を1文字にする。返＝人の返事待ち、承＝承認や入力の待ち（黄の背景は「かも」）、作＝作業中、待＝待機中
function stateOf(row: SessionRow): { ch: string; tone: Tone; label: string } {
  const a = row.activity ?? null
  if (row.status === 'waiting' || (a !== null && a.waitingFor !== null)) {
    return { ch: '承', tone: 'red', label: '承認や入力の待ち' + (a?.waitingFor ? '（' + a.waitingFor + '）' : '') }
  }
  if (row.status === '作業中') {
    if (a !== null && a.tool !== null && !a.toolDone && (a.quietSec ?? 0) >= PERMISSION_QUIET_SEC) {
      return { ch: '承', tone: 'caution', label: '承認待ちかも（道具を使ったまま ' + String(a.quietSec) + '秒止まっている）' }
    }
    return { ch: '作', tone: 'blue', label: '作業中' }
  }
  if (row.status === '待機中') {
    return a !== null && a.awaitsUser ? { ch: '返', tone: 'red', label: '返事待ち' } : { ch: '待', tone: 'plain', label: '待機中' }
  }
  return { ch: '？', tone: 'plain', label: row.status }
}

function toneColor(tone: Tone): string {
  if (tone === 'red') return RED
  if (tone === 'blue') return BLUE
  return BLACK
}

// 送った側（sent）と受けた側（received）の記録を、同じ印・2分以内・食い違わない宛先なら1つにする。
// 合図表.py の1回の実行で両方そろえば paired で届き、別々の回に届いたものはここでそろえる
function mergeBell(list: Bell[], bell: Bell): void {
  const sameKey = list.filter(one => bell.key !== '' && one.key === bell.key && Math.abs(one.stamp - bell.stamp) <= PAIR_MS)
  // 同じ文面の印で、すでに突き合わせ済みか、同じ側の記録なら、同じ合図（2回目以降の読み込みで重ねない）
  if (sameKey.some(one => one.via === 'paired' || one.via === bell.via)) return
  const twin = sameKey.find(one => one.via !== bell.via)
  if (twin !== undefined) {
    const sender = twin.via === 'sent' ? twin : bell
    const receiver = twin.via === 'received' ? twin : bell
    const isSameTo = !isLiveId(sender.to) || sender.via === 'paired' || sender.to === receiver.to
    const isSameFrom = !isLiveId(receiver.from) || receiver.via === 'paired' || receiver.from === sender.from
    if (isSameTo && isSameFrom) {
      twin.stamp = sender.stamp
      twin.from = sender.from
      twin.to = receiver.to
      twin.text = sender.text
      twin.via = 'paired'
      return
    }
  }
  const same = list.find(one => one.from === bell.from && one.to === bell.to && Math.abs(one.stamp - bell.stamp) <= MERGE_MS)
  if (same !== undefined) return
  list.push({ ...bell })
}

// セッション間のやり取りをシーケンス図（UML）で描く。縦の線が1セッション、上から下へ時間が流れ、
// 横の矢印が1回の連絡（合図＝橙、黒板＝青）。白い背景に黒い文字で、ふつうの色だけ使う。
// 図はペインの幅と高さいっぱいに広げる（markup の width を 100% にし、viewBox の縦横比をペインに合わせる）。
// 書くのは、名前・状態・時刻・件名だけ。詳しい情報は、矢印にマウスを載せたときに浮き出る（<title>）
const SEQ_BG = '#ffffff'
const SEQ_LINE = '#8a98a6'
const SEQ_TEXT = '#000000'
const SEQ_BUSY_FILL = '#d9eefa'
const SEQ_BUSY_LINE = '#1f6fb2'
const SEQ_IDLE_FILL = '#ffffff'
const SEQ_IDLE_LINE = '#8a98a6'
const SEQ_GONE_FILL = '#eeeeee'
const SEQ_BELL = '#d35400'
const SEQ_BOARD = '#1f6fb2'
// このセッション（自分）は薄い橙。名札も縦の棒も、作業中か待機中かにかかわらずこの色にする
const SEQ_SELF_FILL = '#ffe4c4'
const SEQ_SELF_LINE = '#e8913a'
const SEQ_SELF_BAR = '#f5a04a'
const SEQ_ROWS_MAX = 14

// SVG の要素を1つ作る。属性は名前と値の組で、値が undefined の属性は書かない。inner が空なら自己閉じ
function el(tag: string, attrs: Record<string, string | number | undefined>, inner = ''): string {
  let out = '<' + tag
  for (const key of Object.keys(attrs)) {
    const v = attrs[key]
    if (v !== undefined) out += ' ' + key + '="' + String(v) + '"'
  }
  return inner === '' ? out + '/>' : out + '>' + inner + '</' + tag + '>'
}

// 図の寸法。行＝セッション（n 行）、列＝連絡（m 列）。幅はペインに合わせ、高さは行数に合わせて広げる
type SeqFrame = { W: number; H: number; left: number; right: number; top: number; rowH: number; colW: number; nameW: number }
function seqFrame(n: number, m: number, widthCells: number, heightRows: number): SeqFrame {
  // 幅は 900 以上にする。細く描くとペインいっぱいに引き伸ばされ、縦に長くなりすぎて VS Code が描かない
  const W = Math.round(clamp(widthCells * 8.4, 600, 1800))
  const nameW = Math.round(clamp(W * 0.2, 140, 220))
  const left = nameW + 16
  const right = 16
  const top = 44
  // 行の高さは名札の高さぎりぎりに詰め、図の高さも行の数だけにする（私の指示「上下の空間がこんなに広くなくても大丈夫。こじんまりと」）。
  // ペインの高さ（heightRows）には合わせない。高さは幅の2倍まで（縦に長すぎる図は描かれない）
  void heightRows
  const rowH = 36
  const H = Math.min(Math.round(top + rowH * n + 16), W * 2)
  const colW = (W - left - right) / Math.max(1, m)
  return { W, H, left, right, top, rowH, colW, nameW }
}

// 1セッション分。横の線、自分なら薄い橙の棒、作業中なら青い棒、左に名札と状態
function seqLane(f: SeqFrame, row: SessionRow, y: number): string {
  const isBusy = row.status === '作業中'
  const fill = row.isSelf ? SEQ_SELF_FILL : isBusy ? SEQ_BUSY_FILL : SEQ_IDLE_FILL
  const stroke = row.isSelf ? SEQ_SELF_LINE : isBusy ? SEQ_BUSY_LINE : SEQ_IDLE_LINE
  const boxX = 28
  const boxW = f.nameW - boxX
  const cx = (boxX + boxW / 2).toFixed(1)
  const yy = y.toFixed(1)
  const barW = f.W - f.right - f.left
  let out = el('line', { x1: f.left, y1: yy, x2: f.W - f.right, y2: yy, stroke: SEQ_LINE, 'stroke-width': '1.5' })
  if (row.isSelf) out += el('rect', { x: f.left, y: (y - 4).toFixed(1), width: barW, height: 8, fill: SEQ_SELF_BAR, 'fill-opacity': '0.45' })
  else if (isBusy) out += el('rect', { x: f.left, y: (y - 4).toFixed(1), width: barW, height: 8, fill: SEQ_BUSY_LINE, 'fill-opacity': '0.35' })
  // 状態は1文字（作＝作業中、待＝待機中）で、名札の左の同じ行に書く（私の指示「2行にしないこと。1文字で表現して1行に」）
  out += el('text', { x: 16, y: (y + 5).toFixed(1), 'text-anchor': 'middle', fill: SEQ_TEXT, 'font-weight': 'bold', 'font-size': '15' }, isBusy ? '作' : '待')
  out += el('rect', { x: boxX, y: (y - 14).toFixed(1), width: boxW, height: 28, rx: 6, fill, stroke, 'stroke-width': row.isSelf ? '2.5' : '1.2' })
  out += el('text', { x: cx, y: (y + 5).toFixed(1), 'text-anchor': 'middle', fill: SEQ_TEXT, 'font-weight': 'bold', 'font-size': '15' }, xml(cut(row.name, Math.floor(boxW / 8) - 1)))
  return out
}

// 1回の連絡。上に時刻、縦の矢印（自分あては小さな輪）、矢印の右に件名。マウスを載せると <title> の情報が浮き出る
function seqArrow(f: SeqFrame, item: FeedItem, x: number, y1: number, y2: number, now: number): string {
  const isBell = item.kind === '合図'
  const color = isBell ? SEQ_BELL : SEQ_BOARD
  const span = Math.abs(y2 - y1)
  const head = Math.max(0, span - 10)
  const kindText = isBell ? '合図（SendMessage）' : '黒板' + (item.kind !== '' ? '・' + item.kind : '')
  const stateText = item.isUnread === null ? '' : item.isUnread ? '・未読' : '・既読'
  const tip = item.time + '（' + ago(item.stamp, now) + '）　' + item.from + ' → ' + item.to + '\n' + kindText + stateText + '\n' + item.subject
  const xs = x.toFixed(1)
  const isLoop = head < 12
  const bgY = isLoop ? y1 - f.rowH / 2 + 5 : Math.min(y1, y2) - 10
  const bgH = isLoop ? f.rowH - 10 : span + 20
  const isWide = f.colW >= 48
  let out = '<g class="m"><title>' + xml(tip) + '</title>'
  out += el('rect', { class: 'bg', x: (x - f.colW / 2 + 3).toFixed(1), y: bgY.toFixed(1), width: Math.max(12, f.colW - 6).toFixed(1), height: bgH.toFixed(1), rx: 8, fill: color, 'fill-opacity': '0' })
  // 時刻。列が狭いときは書かない（マウスを載せると出る）。斜めの文字（transform）は VS Code で図が出なくなるため使わない
  if (isWide) out += el('text', { x: xs, y: f.top - 10, 'text-anchor': 'middle', fill: SEQ_TEXT, 'font-size': '13' }, item.time)
  if (isLoop) out += el('circle', { cx: xs, cy: y1.toFixed(1), r: 6, fill: 'none', stroke: color, 'stroke-width': '1.5' })
  else out += el('line', { x1: xs, y1: y1.toFixed(1), x2: xs, y2: (y1 + Math.sign(y2 - y1) * head).toFixed(1), stroke: color, 'stroke-width': '1.5', 'marker-end': 'url(#' + (isBell ? 'seqBell' : 'seqBoard') + ')' })
  // 件名は矢印の右に短く（全文は <title>）。列が狭いときは書かない
  if (isWide) {
    const cells = Math.max(4, Math.floor((f.colW - 14) / 7))
    out += el('text', { x: (x + 8).toFixed(1), y: ((y1 + y2) / 2 + 5).toFixed(1), 'text-anchor': 'start', fill: SEQ_TEXT, 'font-size': '13', 'font-weight': item.isUnread === true ? 'bold' : undefined }, xml(cut(item.subject, cells)))
  }
  return out + '</g>'
}

// 図の全体。行＝セッション（自分が一番上、あとは名簿の順。閉じた相手は呼ぶ側で除いてある）、縦の矢印＝連絡、左から右へ時間
// 矢じり2種（合図＝橙、黒板＝青）と、マウスを載せたときの見た目
const SEQ_DEFS =
  '<defs>' +
  '<marker id="seqBell" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="' + SEQ_BELL + '"/></marker>' +
  '<marker id="seqBoard" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="' + SEQ_BOARD + '"/></marker>' +
  '</defs>' +
  '<style>.m:hover line{stroke-width:3}.m:hover rect.bg{fill-opacity:.15}</style>'

function buildSequenceSvg(rows: SessionRow[], items: FeedItem[], widthCells: number, heightRows: number, now: number): string {
  const lanes = [...rows.filter(row => row.isSelf), ...rows.filter(row => !row.isSelf)]
  const f = seqFrame(Math.max(1, lanes.length), items.length, widthCells, heightRows)
  const yOf = (name: string): number => f.top + f.rowH * (lanes.findIndex(row => row.name === name) + 0.5)
  const parts: string[] = []
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + f.W + ' ' + f.H + '" width="100%" font-family="Meiryo, sans-serif" font-size="16">')
  parts.push(SEQ_DEFS)
  parts.push(el('rect', { x: 0, y: 0, width: f.W, height: f.H, fill: SEQ_BG }))
  for (const row of lanes) parts.push(seqLane(f, row, yOf(row.name)))
  items.forEach((item, i) => parts.push(seqArrow(f, item, f.left + f.colW * (i + 0.5), yOf(item.from), yOf(item.to), now)))
  if (items.length === 0) {
    parts.push(el('text', { x: (f.left + (f.W - f.left - f.right) / 2).toFixed(1), y: f.top + 40, 'text-anchor': 'middle', fill: SEQ_TEXT }, '直近24時間、セッション間のやり取りはありません'))
  }
  parts.push('</svg>')
  return parts.join('')
}


function pairText(item: FeedItem): string {
  return item.from + (item.kind === '合図' ? ' 🔔→ ' : ' → ') + item.to
}

function bellItems(): FeedItem[] {
  return bells.map(bell => ({
    stamp: bell.stamp,
    time: hhmm(bell.stamp),
    from: nameOf(bell.from),
    to: nameOf(bell.to),
    kind: '合図',
    subject: bell.text.replace(/^（[^）]*入力欄[^）]*）\s*/, ''),
    isUnread: null,
  }))
}

// 黒板の連絡と合図を時刻順に1本にする。直近24時間に無ければ直近5件を出す
function buildFeed(now: number): { feed: FeedItem[]; note: string } {
  const all = [...boardItems, ...bellItems()].sort((a, b) => a.stamp - b.stamp)
  const recent = all.filter(item => now - item.stamp <= LINK_WINDOW_MS)
  if (recent.length > 0) {
    const boards = recent.filter(item => item.kind !== '合図').length
    return { feed: recent.slice(-FEED_MAX), note: '直近24時間のやり取り（黒板 ' + boards + '件・合図 ' + (recent.length - boards) + '件）' }
  }
  return { feed: all.slice(-5), note: '直近24時間のやり取りは無し（直近5件を表示）' }
}

// 直近24時間のやり取りを、送り主→宛先ごとの回数にまとめる（会話の地図の線）
function buildLinks(now: number): Link[] {
  const counts = new Map<string, Link>()
  for (const item of [...boardItems, ...bellItems()]) {
    if (now - item.stamp > LINK_WINDOW_MS || item.from === item.to) continue
    const key = item.from + '\u0000' + item.to
    const found = counts.get(key)
    if (found === undefined) counts.set(key, { from: item.from, to: item.to, count: 1, last: item.stamp })
    else {
      found.count += 1
      found.last = Math.max(found.last, item.stamp)
    }
  }
  return [...counts.values()]
}

// 直近30分にやり取りした相手の名前。無ければ null
function partnerOf(row: Listed, feed: FeedItem[], now: number): string | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const item = feed[i]
    if (item === undefined || now - item.stamp > PARTNER_WINDOW_MS) continue
    if (item.from === row.name) return item.to
    if (item.to === row.name) return item.from
  }
  return null
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 会話の地図（SVG）。話している2つのセッションを1組1行にし、左右に並べて線で結ぶ。
// 線の矢印で向きを示す（両方から連絡していれば両端に矢印、片方だけなら1つ）。
// 1時間以内に連絡があった組は濃い青、それより前は薄い灰色。新しい組ほど上に置く
function buildMapSvg(rows: SessionRow[], links: Link[], width: number, now: number, isPlain: boolean): string {
  const styleOf = (name: string): { fill: string; stroke: string; ch: string; bold: boolean } => {
    const row = rows.find(one => one.name === name)
    if (row === undefined) return { fill: '#eeeeee', stroke: '#999999', ch: '', bold: false }
    const state = stateOf(row)
    if (isPlain) {
      return row.status === '作業中'
        ? { fill: '#d9eefa', stroke: BLUE, ch: '', bold: row.isSelf }
        : { fill: '#ffffff', stroke: '#777777', ch: '', bold: row.isSelf }
    }
    const color =
      state.tone === 'red' ? { fill: '#ffe0e0', stroke: RED } :
      state.tone === 'caution' ? { fill: CAUTION_BG, stroke: '#b08000' } :
      state.tone === 'blue' ? { fill: '#d9eefa', stroke: BLUE } :
      { fill: '#ffffff', stroke: '#777777' }
    return { ...color, ch: state.ch, bold: row.isSelf }
  }
  const rank = (name: string): number => {
    const i = rows.findIndex(row => row.name === name)
    return i < 0 ? rows.length : i
  }
  // 向きを問わず、2つのセッションの組ごとにまとめる
  type Pair = { a: string; b: string; ab: number; ba: number; last: number }
  const pairs = new Map<string, Pair>()
  for (const link of links) {
    const [a, b] = rank(link.from) <= rank(link.to) ? [link.from, link.to] : [link.to, link.from]
    const key = a + '\u0000' + b
    const pair = pairs.get(key) ?? { a, b, ab: 0, ba: 0, last: 0 }
    if (link.from === a) pair.ab += link.count
    else pair.ba += link.count
    pair.last = Math.max(pair.last, link.last)
    pairs.set(key, pair)
  }
  // 片方だけの組は、送った側を左にする（矢印がいつも右を向く）
  const list = [...pairs.values()]
    .map(pair => (pair.ab === 0 && pair.ba > 0 ? { a: pair.b, b: pair.a, ab: pair.ba, ba: 0, last: pair.last } : pair))
    .sort((x, y) => y.last - x.last)
    .slice(0, 8)
  const W = Math.round(clamp(width, 320, 560))
  const boxW = Math.min(150, Math.floor((W - 40) / 2.6))
  const boxH = 20
  const rowH = 26
  const H = Math.max(1, list.length) * rowH + 4
  const leftX = 2
  const rightX = W - 2 - boxW
  const parts: string[] = []
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" font-family="Meiryo, sans-serif" font-size="11">')
  parts.push(
    '<defs>' +
      '<marker id="headBlue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + BLUE + '"/></marker>' +
      '<marker id="headGray" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#999999"/></marker>' +
    '</defs>',
  )
  parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>')
  const box = (name: string, x: number, y: number): void => {
    const st = styleOf(name)
    const label = (st.ch !== '' ? st.ch + ' ' : '') + cut(name, 16)
    parts.push('<rect x="' + x + '" y="' + (y - boxH / 2) + '" width="' + boxW + '" height="' + boxH + '" rx="4" fill="' + st.fill + '" stroke="' + st.stroke + '" stroke-width="1.5"/>')
    parts.push('<text x="' + (x + boxW / 2) + '" y="' + (y + 4) + '" text-anchor="middle" fill="#000000"' + (st.bold ? ' font-weight="bold"' : '') + '>' + xml(label) + '</text>')
  }
  list.forEach((pair, i) => {
    const y = 2 + i * rowH + rowH / 2
    const isRecent = now - pair.last <= RECENT_LINK_MS
    const head = isRecent ? 'headBlue' : 'headGray'
    const stroke = isRecent ? BLUE + '" stroke-opacity="0.9' : '#999999" stroke-opacity="0.6'
    const sw = (1.5 + Math.min(pair.ab + pair.ba, 6) * 0.5).toFixed(1)
    const x1 = leftX + boxW + 3
    const x2 = rightX - 3
    parts.push(
      '<line x1="' + x1 + '" y1="' + y + '" x2="' + x2 + '" y2="' + y + '" stroke="' + stroke + '" stroke-width="' + sw + '"' +
        (pair.ab > 0 ? ' marker-end="url(#' + head + ')"' : '') +
        (pair.ba > 0 ? ' marker-start="url(#' + head + ')"' : '') +
        '/>',
    )
    if (!isPlain) {
      parts.push('<text x="' + ((x1 + x2) / 2) + '" y="' + (y - 4) + '" text-anchor="middle" fill="#000000">' + pair.ab + ' / ' + pair.ba + '</text>')
    }
    box(pair.a, leftX, y)
    box(pair.b, rightX, y)
  })
  parts.push('</svg>')
  return parts.join('')
}

async function findHome($: EngineInterface): Promise<string> {
  const profile = await $.env.get('USERPROFILE')
  if (profile) return profile
  return (await $.env.get('HOME')) ?? ''
}

// ~/.claude/projects の各フォルダーから、ID で始まる .jsonl（生ログ）を探す。
// 同じ ID が複数のフォルダーにあるときは、いちばん新しく書かれたものを使う
async function findLogPath($: EngineInterface, projectsDir: string, id: string): Promise<string | null> {
  let folders: FsEntry[]
  try {
    folders = await $.fs.list(projectsDir)
  } catch {
    return null
  }
  let best: { path: string; mtimeMs: number } | null = null
  for (const folder of folders) {
    if (folder.kind !== 'dir') continue
    const dir = join(projectsDir, folder.name)
    let entries: FsEntry[]
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.startsWith(id) || !entry.name.endsWith('.jsonl')) continue
      if (best === null || entry.mtimeMs > best.mtimeMs) best = { path: join(dir, entry.name), mtimeMs: entry.mtimeMs }
    }
  }
  return best === null ? null : best.path
}

// 在席表.py を回して名前・宛先名・状態を取り直す。失敗したら理由を返す（成功なら null）
// 登録情報（~/.claude/sessions/*.json）を読み、起動の種類（entrypoint）が sdk-cli のセッションの ID（先頭8桁）を集める。
// sdk-cli は、タスクスケジューラなどの自動タスクが起こしたセッション。人が開いた VS Code のタブは claude-vscode
async function automatedIds($: EngineInterface): Promise<Set<string>> {
  const ids = new Set<string>()
  const dir = join(home, '.claude', 'sessions')
  let entries: FsEntry[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return ids
  }
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const data = JSON.parse(await $.fs.read(join(dir, entry.name))) as { sessionId?: unknown; entrypoint?: unknown }
      if (data.entrypoint === 'sdk-cli' && typeof data.sessionId === 'string') ids.add(data.sessionId.slice(0, 8))
    } catch {
      // 書きかけなどで読めない登録は飛ばす
    }
  }
  return ids
}

async function refreshList($: EngineInterface): Promise<string | null> {
  const script = join($.plugin.root, 'tools', ATTENDANCE_TOOL)
  let ran
  try {
    ran = await $.process.run(['python', '-X', 'utf8', script], { timeoutMs: 20000 })
  } catch (error) {
    return '在席表.py を起動できません: ' + String(error)
  }
  if (ran.exitCode !== 0) {
    return '在席表.py が失敗しました（exit ' + ran.exitCode + '）: ' + ran.stderr.trim().slice(0, 200)
  }
  // 自動タスクのセッション（名前なしで出る）は、人が開いたタブではないので名簿から外す
  const automated = await automatedIds($)
  listed = parseAttendance(ran.stdout).filter(row => !automated.has(row.id))
  const projectsDir = join(home, '.claude', 'projects')
  for (const row of listed) {
    if (logPaths[row.id] !== undefined) continue
    const found = await findLogPath($, projectsDir, row.id)
    if (found !== null) logPaths[row.id] = found
  }
  return null
}

// 黒板（00_黒板\Claude）のファイル名から、今日のやり取りを読む
async function refreshBoard($: EngineInterface): Promise<string | null> {
  const dir = join(workspace, ...BOARD_PARTS)
  let entries: FsEntry[]
  try {
    // 黒板のフォルダーが無い人には、黒板の部分を出さない（失敗にもしない）
    if (!(await $.fs.exists(dir))) {
      boardItems = []
      return null
    }
    entries = await $.fs.list(dir)
  } catch (error) {
    return '黒板を読めません: ' + String(error)
  }
  const items: FeedItem[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    const item = parseBoardName(entry.name)
    if (item !== null) items.push(item)
  }
  boardItems = items
  return null
}

// 合図表.py を回して、SendMessage の合図を増えた分だけ取り込む
async function refreshBells($: EngineInterface): Promise<string | null> {
  const script = join($.plugin.root, 'tools', BELLS_TOOL)
  let ran
  try {
    ran = await $.process.run(['python', '-X', 'utf8', script, '-'], { stdin: JSON.stringify(bellOffsets), timeoutMs: 25000 })
  } catch (error) {
    return '合図表.py を起動できません: ' + String(error)
  }
  if (ran.exitCode !== 0) {
    return '合図表.py が失敗しました（exit ' + ran.exitCode + '）: ' + ran.stderr.trim().slice(0, 200)
  }
  let parsed: { offsets?: Record<string, number>; bells?: Array<{ at: string; from: string; to: string; via: string; key: string; text: string }> }
  try {
    parsed = JSON.parse(ran.stdout)
  } catch {
    return '合図表.py の出力が JSON ではありません'
  }
  bellOffsets = parsed.offsets ?? bellOffsets
  const merged = [...bells]
  for (const found of parsed.bells ?? []) {
    const stamp = Date.parse(found.at)
    if (Number.isNaN(stamp)) continue
    mergeBell(merged, { stamp, from: found.from, to: found.to, via: found.via, key: found.key ?? '', text: found.text })
  }
  bells = merged.sort((a, b) => a.stamp - b.stamp).slice(-200)
  return null
}

type HelperSession = {
  id?: string
  waitingFor?: string | null
  ask?: { at?: string; text?: string } | null
  reply?: { at?: string; text?: string; awaitsUser?: boolean } | null
  tool?: { at?: string; name?: string; detail?: string; done?: boolean } | null
  quietSec?: number | null
  recent?: string
  recentKey?: string
  entries?: Array<{ at?: string | null; kind?: string; who?: string; text?: string; times?: number }>
}

function stampOf(text: string | undefined): number | null {
  if (text === undefined) return null
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? null : ms
}

// mod に同梱の 様子表.py を回して、各セッションの最後の指示・返事・道具を取り込む
async function refreshActivity($: EngineInterface): Promise<string | null> {
  const script = join($.plugin.root, 'tools', '様子表.py')
  let ran
  try {
    ran = await $.process.run(['python', '-X', 'utf8', script], { timeoutMs: 20000 })
  } catch (error) {
    return '様子表.py を起動できません: ' + String(error)
  }
  if (ran.exitCode !== 0) {
    return '様子表.py が失敗しました（exit ' + ran.exitCode + '）: ' + ran.stderr.trim().slice(0, 200)
  }
  let parsed: { sessions?: HelperSession[] }
  try {
    parsed = JSON.parse(ran.stdout)
  } catch {
    return '様子表.py の出力が JSON ではありません'
  }
  const next: Record<string, RawActivity> = {}
  for (const s of parsed.sessions ?? []) {
    if (typeof s.id !== 'string') continue
    const tool = s.tool ?? null
    next[s.id] = {
      ask: s.ask?.text ?? null,
      askAt: stampOf(s.ask?.at),
      reply: s.reply?.text ?? null,
      replyAt: stampOf(s.reply?.at),
      awaitsUser: s.reply?.awaitsUser === true,
      tool: tool === null ? null : ((tool.name ?? '') + (tool.detail ? ' ' + tool.detail : '')).trim(),
      toolAt: stampOf(tool?.at),
      toolDone: tool?.done === true,
      quietSec: typeof s.quietSec === 'number' ? s.quietSec : null,
      waitingFor: typeof s.waitingFor === 'string' && s.waitingFor !== '' ? s.waitingFor : null,
      recent: typeof s.recent === 'string' ? s.recent : '',
      recentKey: typeof s.recentKey === 'string' ? s.recentKey : '',
      entries: (s.entries ?? []).map(one => ({
        at: stampOf(one.at ?? undefined),
        kind: (one.kind === 'ask' || one.kind === 'peer-in' || one.kind === 'peer-out' || one.kind === 'claude' || one.kind === 'tool') ? one.kind : 'claude',
        who: typeof one.who === 'string' ? one.who : '',
        text: typeof one.text === 'string' ? one.text : '',
        times: typeof one.times === 'number' ? one.times : 1,
      })),
    }
  }
  activities = next
  return null
}

function plainActivity(raw: RawActivity | undefined): Activity | null {
  if (raw === undefined) return null
  const { recent: _recent, recentKey: _key, ...rest } = raw
  return rest
}

// 生ログの大きさを測り、様子・やり取りと合わせてペインが読む値を書く（書くとペインが描き直される）
async function publish($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const { feed, note } = buildFeed(now)
  const rows: SessionRow[] = []
  for (const row of listed) {
    const path = logPaths[row.id]
    let bytes: number | null = null
    if (path !== undefined) {
      try {
        bytes = (await $.fs.stat(path)).size
      } catch {
        bytes = null
      }
    }
    rows.push({
      ...row,
      bytes,
      isSelf: selfId.startsWith(row.id),
      partner: partnerOf(row, feed, now),
      activity: plainActivity(activities[row.id]),
      summary: summaries[row.id]?.text ?? null,
    })
  }
  const errors = [lastListError, lastFeedError].filter((text): text is string => text !== null)
  await update($, snapshot, () => ({
    rows,
    feed,
    feedNote: note,
    links: buildLinks(now),
    updatedAt: now,
    error: errors.length > 0 ? errors.join(' / ') : null,
  }))
}

// 様子が変わったセッションを1つ選び、小さなモデルで2行に要約する（全体で20秒に1回、1つのセッションは3分に1回まで）
async function summarizeNext($: EngineInterface): Promise<void> {
  if (isSimple || !isSummaryOn || isSummarizing) return
  const now = await $.clock.now()
  if (now - lastSummaryCallAt < SUMMARY_GAP_MS) return
  let chosen: { id: string; raw: RawActivity } | null = null
  for (const row of listed) {
    const raw = activities[row.id]
    if (raw === undefined || raw.recent === '' || raw.recentKey === '') continue
    const done = summaries[row.id]
    if (done !== undefined && (done.key === raw.recentKey || now - done.at < SUMMARY_EVERY_MS)) continue
    chosen = { id: row.id, raw }
    break
  }
  if (chosen === null) return
  isSummarizing = true
  lastSummaryCallAt = now
  try {
    const result = await $.model.complete({ model: summaryModel, system: SUMMARY_SYSTEM, prompt: chosen.raw.recent, maxTokens: 200, timeoutMs: 30000 })
    const text = result.isAnswered
      ? result.text.trim().split(/\r?\n/).map(line => line.trim()).filter(line => line !== '').slice(0, 2).join(' ／ ')
      : '（要約できませんでした: ' + result.reason + '）'
    summaries[chosen.id] = { key: chosen.raw.recentKey, text, at: now }
  } catch (error) {
    summaries[chosen.id] = { key: chosen.raw.recentKey, text: '（要約できませんでした: ' + String(error) + '）', at: now }
  } finally {
    isSummarizing = false
  }
  await publish($)
}

// 生ログのファイル名（<セッションID>.jsonl）から、ID の全桁を取り出す
function fullIdOf(id8: string): string | null {
  const path = logPaths[id8]
  if (path === undefined) return null
  const name = path.split(/[\\/]/).pop() ?? ''
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : null
}

// 他のセッションへ送る文の頭に付ける1行（相手の Claude に、人が直接打った文だと伝える）
function fromLine(): string {
  return senderName !== '' ? '（' + senderName + 'が監視画面の入力欄から送った文です）' : '（監視画面の入力欄から、使っている人が直接打った文です）'
}

// 送る文の終わりに添える、返事の返し方（先頭の目印で、この画面が返事を拾う）
function replyLine(id8: string): string {
  const self = listed.find(row => selfId.startsWith(row.id))
  return '（返事をするときは、先頭に' + REPLY_MARK + ':' + id8 + '】と付けて、この連絡の送り主へ SendMessage で1〜2行で返してください。' +
    (self !== undefined ? '送り主は、監視画面を開いているセッション「' + self.name + '」です。' : '') + '）' +
    (selfId !== '' ? '〔送り主:' + selfId.slice(0, 8) + '〕' : '')
}

// この画面からのやり取りに1件足す（直近の TALK_MAX 件だけ残す）
async function addTalk($: EngineInterface, item: TalkItem): Promise<void> {
  await update($, talk, list => [...(Array.isArray(list) ? list : []), item].slice(-TALK_MAX))
}

// 届いた返事の本文から、包み（cross-session-message）と目印を外し、1行にする
function replyBody(text: string): string {
  return text
    .replace(/Another Claude session sent a message:/g, '')
    .replace(/<\/?cross-session-message[^>]*>/g, '')
    .replace(/【監視画面へ:?[0-9a-f]{0,8}】/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// 返事を送ってきた相手の名前。目印の ID、なければ包みの from-name（宛先名）から引く
function replySender(text: string): string {
  const byMark = /【監視画面へ:([0-9a-f]{8})】/.exec(text)
  if (byMark !== null && byMark[1] !== undefined) return nameOf(byMark[1])
  const byEnvelope = /from-name="([^"]+)"/.exec(text)
  if (byEnvelope !== null && byEnvelope[1] !== undefined) {
    const name = byEnvelope[1]
    const row = listed.find(one => one.dest === name)
    return row !== undefined ? row.name : name
  }
  return '相手不明'
}

// 入力欄の文を送る。このセッションなら使っている人の発言として、他のセッションなら SendMessage と同じ経路で
async function sendText($: EngineInterface, text: string): Promise<void> {
  const body = text.trim()
  if (body === '') return
  const to = await read($, target)
  const at = hhmm(await $.clock.now())
  let note: string
  if (to === SELF) {
    // 手が空いたら始まる。始まるまで待たない
    $.prompt.submit({ text: body, asUser: true }).catch(() => undefined)
    note = at + ' このセッションへ送りました（Claude の手が空いたら始まります）'
  } else {
    const row = listed.find(one => one.id === to)
    const sessionId = fullIdOf(to)
    if (row === undefined || sessionId === null) {
      note = at + ' 送れませんでした（送り先のセッションが見つかりません）'
    } else {
      try {
        const sent = await $.session.send({ to: { sessionId }, text: fromLine() + '\n' + body + '\n' + replyLine(row.id) })
        note = sent.isDelivered ? at + ' ' + row.name + ' へ送りました' : at + ' ' + row.name + ' へ送れませんでした（' + (sent.reason ?? '理由不明') + '）'
        await addTalk($, { at: await $.clock.now(), dir: 'out', peer: row.name, text: body, status: sent.isDelivered ? '届いた' : '届かなかった' })
      } catch (error) {
        note = at + ' ' + row.name + ' へ送れませんでした（' + String(error) + '）'
      }
    }
  }
  await update($, sendNote, () => note)
  await update($, sendCount, n => n + 1)
}

// 2秒ごとの1回分。前の回がまだ動いていたら飛ばす
async function tick($: EngineInterface): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    const now = await $.clock.now()
    if (listed.length === 0 || now - lastListAt >= LIST_EVERY_MS) {
      lastListAt = now
      lastListError = await refreshList($)
    }
    if (lastFeedAt === 0 || now - lastFeedAt >= FEED_EVERY_MS) {
      lastFeedAt = now
      const boardError = await refreshBoard($)
      const bellError = await refreshBells($)
      const activityError = await refreshActivity($)
      lastFeedError = boardError ?? bellError ?? activityError
    }
    await publish($)
  } catch (error) {
    await update($, snapshot, prev => ({ ...prev, error: String(error) }))
  } finally {
    isBusy = false
  }
  void summarizeNext($)
}

export const register: Register = (on, options) => {
  senderName = typeof options.senderName === 'string' ? options.senderName.trim() : ''
  isSummaryOn = options.summaries !== false
  isSimple = options.view !== 'detail'
  summaryModel = typeof options.summaryModel === 'string' && options.summaryModel.trim() !== '' ? options.summaryModel.trim() : 'haiku'
  const configuredDir = typeof options.workspaceDir === 'string' ? options.workspaceDir.trim() : ''

  on('session.start', async ($, e, next) => {
    home = await findHome($)
    workspace = configuredDir !== '' ? configuredDir : e.cwd
    try {
      selfId = await $.session.id()
    } catch {
      selfId = ''
    }
    // 読み込みの記録（いつ・どの版が読み込まれたか）。画面が古いままかを、私が確かめるために書く
    try {
      await $.fs.write(join($.plugin.root, '起動記録.txt'), 'v' + VERSION + ' ' + new Date(await $.clock.now()).toISOString() + '\n')
    } catch {
      // 書けなくても動く
    }
    // ペインは自分からは開かない。読み直しのときは、開いたままのペインが残っているか、/sessions で開いてあれば続けて動く
    try {
      const panes = await $.ui.panes()
      const wanted = await read($, paneWanted)
      isPaneOpen = panes.some(pane => pane.id === PANE) || wanted === true
      if (isPaneOpen && !panes.some(pane => pane.id === PANE)) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    } catch {
      isPaneOpen = false
    }
    try {
      await $.command.register({
        name: 'sessions',
        description: 'セッション一覧のペインを開く（返事待ち・いまの作業・会話の地図・要約・やり取り）',
        immediate: true,
      })
    } catch {
      // 同じ名前のコマンドがあるときは登録しない
    }
    if (isPaneOpen) void tick($)
    $.clock.every(SIZE_EVERY_MS, () => {
      if (isPaneOpen) void tick($)
    })

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    isPaneOpen = true
    await update($, paneWanted, () => true)
    // 前に出す指定（focus）を付ける。付けないと、ほかの mod のペイン（例 /mission）の後ろのタブに開いたままになる
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void tick($)
    if (!opened.isPlaced) {
      return { text: 'セッション一覧 v' + VERSION + '：ペインを置けませんでした: ' + opened.reason }
    }
    // 版を出す。どの中身が動いているかを、私が会話の記録から確かめられる
    return { text: 'セッション一覧 v' + VERSION }
  })

  // /sessions で開いたのに置かれていないペインは、使っている人の入力のついでに開き直す（「求められた開き方」になり、狭いパネルでも置かれる）
  on('prompt.submit', async ($, e, next) => {
    if (isPaneOpen) {
      const panes = await $.ui.panes()
      const mine = panes.find(pane => pane.id === PANE)
      if (mine === undefined || !mine.isPlaced) {
        await $.ui.open({ id: PANE, title: TITLE })
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // 目印の付いた返事は、この画面のやり取りにだけ出し、このセッションの AI には渡さない（チャットが乱れないように）。
  // 目印の ID がこのセッション自身なら、ほかのセッションの入力欄から届いた連絡の「返事の返し方」なので、AI に渡す（同じ MOD を入れたセッションどうしで、連絡が消えないように）
  on('session.receive', async ($, e, next) => {
    if (!e.text.includes(REPLY_MARK)) return next(e)
    if (selfId !== '' && e.text.includes(REPLY_MARK + ':' + selfId.slice(0, 8) + '】')) return next(e)
    await addTalk($, { at: await $.clock.now(), dir: 'in', peer: replySender(e.text), text: replyBody(e.text), status: '' })
    return { consumed: '監視画面への返事として、セッション一覧のペインに出した' }
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    isPaneOpen = false
    // 手で閉じたときだけ「開かない」を覚える。読み直しや仕組みの都合で閉じたときは、次の入力で開き直す
    if (e.origin.kind === 'person') await update($, paneWanted, () => false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // 入力欄・選択欄・図は、描ける画面でだけ出す（ターミナルは図を描けない）
    const Input = 'Input' in table ? table.Input : undefined
    const Select = 'Select' in table ? table.Select : undefined
    // ターミナルの表には Svg が無い（あっても描かれない）ので、ターミナルでは文の案内に変える
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    // $.state は読み直しをまたいで残るので、前の版の形の値が来ても落ちないようにそろえる
    const stored = await read($, snapshot)
    const snap: Snapshot = {
      ...EMPTY,
      ...stored,
      links: Array.isArray(stored.links) ? stored.links : [],
      rows: (stored.rows ?? []).map(row => ({ ...row, partner: row.partner ?? null, activity: row.activity ?? null, summary: row.summary ?? null })),
    }
    const chosen = await read($, target)
    const note = await read($, sendNote)
    const count = await read($, sendCount)
    const isMapShown = await read($, showMap)
    const talkStored = await read($, talk)
    const talks = Array.isArray(talkStored) ? talkStored : []
    const others = snap.rows.filter(row => !row.isSelf)
    const options = [{ value: SELF, label: 'このセッション' }, ...others.map(row => ({ value: row.id, label: row.name + '（' + row.id + '）' }))]
    const current = options.some(option => option.value === chosen) ? chosen : SELF
    const measured = e.props.bodyColumns > 0 ? e.props.bodyColumns : (e.viewport?.columns ?? 80)
    const columns = Math.max(40, measured)
    const now = snap.updatedAt

    // この画面からのやり取り（送った文と、返ってきた返事）を、一番下に箇条書きで出す
    const talkBlock = talks.length > 0 && (
      <Box flexDirection="column" marginTop={1}>
        <Text color={BLACK} weight="bold">この画面からのやり取り</Text>
        {talks.map((item, i) => (
          <Text key={'talk-' + String(i)} color={item.dir === 'in' ? BLUE : BLACK} wrap="truncate">
            {cut('・' + hhmm(item.at) + (item.dir === 'out' ? ' → ' : ' ← ') + item.peer + '「' + item.text + '」' + (item.status !== '' ? '　' + item.status : ''), Math.max(20, columns - 2))}
          </Text>
        ))}
      </Box>
    )

    // 1段目: 人の手が要るセッション（返事待ち・承認待ち）
    const states = snap.rows.map(row => ({ row, state: stateOf(row) }))
    const needs = states.filter(({ state }) => state.tone === 'red' || state.tone === 'caution')

    // 名簿の列幅（横幅を取りすぎないように狭くする）
    const nameTexts = snap.rows.map(row => row.name + (row.partner !== null ? ' ⇄' + row.partner : ''))
    const nameWidth = clamp(Math.max(8, ...nameTexts.map(cellWidth)), 8, 20)
    const idWidth = 8
    const destWidth = clamp(Math.max(4, ...snap.rows.map(row => cellWidth(row.dest))), 4, 8)
    const statusWidth = 2
    const barCells = 6
    const mbWidth = 5
    const detailWidth = Math.max(20, columns - 4)
    const maxBytes = Math.max(0, ...snap.rows.map(row => row.bytes ?? 0))

    // やり取りの列幅
    const timeWidth = 5
    const pairWidth = clamp(Math.max(12, ...snap.feed.map(item => cellWidth(pairText(item)))), 12, 30)
    const stateWidth = 4
    const subjectWidth = Math.max(10, columns - 2 - timeWidth - 1 - pairWidth - 1 - stateWidth - 1)

    const mapWidth = Math.round(clamp(columns * 7.5, 320, 1000))

    if (isSimple) {
      // 直近24時間のやり取り（黒板と合図）を古い順に。無ければ直近の分
      // 閉じたセッション（名簿にない相手）との連絡は出さない（閉じた＝要らなくなった、という私の判断）
      const liveNames = new Set(snap.rows.map(row => row.name))
      const all = [...snap.feed].filter(item => liveNames.has(item.from) && liveNames.has(item.to)).sort((a, b) => a.stamp - b.stamp)
      const recent = all.filter(item => now - item.stamp <= LINK_WINDOW_MS)
      const items = (recent.length > 0 ? recent : all).slice(-SEQ_ROWS_MAX)
      const paneRows = Math.max(e.props.scroll.bodyRows, e.viewport?.rows ?? 0, 24)
      const dims = String(columns) + 'x' + String(paneRows) + ' ' + String(e.surface)
      if (dims !== lastDims) {
        lastDims = dims
        void $.fs.write(join($.plugin.root, '表示記録.txt'), new Date(now).toISOString() + ' ' + dims + '\n').catch(() => undefined)
      }
      return (
        <Box flexDirection="column" paddingX={1}>
          {Svg !== undefined ? (
            <Svg source={buildSequenceSvg(snap.rows, items, columns, Math.max(e.props.scroll.bodyRows, e.viewport?.rows ?? 0, 24), now)} alt="セッションを横の行、やり取りを縦の矢印にした図（左から右へ時間）" isInteractive />
          ) : (
            <Box flexDirection="column">
              {items.length === 0 && <Text>直近24時間、セッション間のやり取りはありません</Text>}
              {items.map((item, i) => (
                <Text key={'seq-' + String(i)} wrap="truncate">{item.time + ' ' + pairText(item) + '　' + item.subject}</Text>
              ))}
            </Box>
          )}
          {snap.error !== null && <Text color={RED}>{snap.error}</Text>}
          {talkBlock}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" backgroundColor="#ffffff" paddingX={1}>
        <Text color={BLACK} weight="bold">返事待ち・承認待ち</Text>
        {needs.length === 0 && <Text color={GREEN} weight="bold">人の手を待っているセッションはありません</Text>}
        {needs.map(({ row, state }) => (
          <Box key={'need-' + row.id} flexDirection="column">
            <Text color={state.tone === 'red' ? RED : BLACK} {...(state.tone === 'caution' ? { backgroundColor: CAUTION_BG } : {})} weight="bold" wrap="truncate">
              {'⚠ ' + state.ch + ' ' + row.name + '　' + state.label + (row.activity?.replyAt ? '（' + ago(row.activity.replyAt, now) + '）' : '')}
            </Text>
            {row.activity?.reply ? <Text color={BLACK} wrap="truncate">{'　「' + cut(row.activity.reply, detailWidth - 4) + '」'}</Text> : null}
          </Box>
        ))}

        {Input !== undefined && Select !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Select
              key="target"
              label="送り先"
              options={options}
              value={current}
              onSelect={value => {
                void update($, target, () => value)
              }}
            />
            <Input
              key={'message-' + String(count)}
              label="入力"
              placeholder="ここに打って Enter で送る"
              submitLabel="送信"
              onSubmit={value => {
                void sendText($, value)
              }}
            />
            {note !== '' && <Text color={BLACK}>{note}</Text>}
          </Box>
        )}

        <Box marginTop={1} flexDirection="row" columnGap={2}>
          <Text color={BLACK} weight="bold">会話の地図（直近24時間）</Text>
          <Button
            key="toggle-map"
            label={isMapShown ? '隠す' : '出す'}
            onPress={() => {
              void update($, showMap, shown => !shown)
            }}
          />
        </Box>
        {isMapShown && snap.links.length === 0 && <Text color={BLACK}>直近24時間のやり取りはありません</Text>}
        {isMapShown && snap.links.length > 0 && (Svg !== undefined ? (
          <Svg source={buildMapSvg(snap.rows, snap.links, mapWidth, now, false)} alt="連絡し合っている2つのセッションを1組1行で並べ、向きを矢印で示した図" width={Math.round(clamp(mapWidth, 320, 560))} />
        ) : (
          <Text color={BLACK}>（つながりの図は VS Code とデスクトップ版で表示します）</Text>
        ))}
        {isMapShown && snap.links.length > 0 && <Text color={BLACK} wrap="wrap">赤＝返事や承認の待ち　青＝作業中　白＝待機中　灰色＝名簿にない相手　数字＝左から右の回数 / 右から左の回数</Text>}

        <Box marginTop={1} flexDirection="row" columnGap={1}>
          <Box width={nameWidth}>
            <Text color={BLACK} weight="bold">名前</Text>
          </Box>
          <Box width={idWidth}>
            <Text color={BLACK} weight="bold">ID</Text>
          </Box>
          <Box width={destWidth}>
            <Text color={BLACK} weight="bold">宛先</Text>
          </Box>
          <Box width={statusWidth}>
            <Text color={BLACK} weight="bold">状</Text>
          </Box>
          <Text color={BLACK} weight="bold">ログMB</Text>
        </Box>
        {snap.rows.length === 0 && snap.error === null && (
          <Text color={BLACK}>在席表.py の結果を待っています…</Text>
        )}
        {states.map(({ row, state }, i) => {
          const a = row.activity
          const ask = a?.ask ? '指示 ' + (a.askAt !== null ? hhmm(a.askAt) : '') + '「' + a.ask + '」' : ''
          const tool = a?.tool ? '→ ' + a.tool + (a.toolDone ? '（済 ' + ago(a.toolAt, now) + '）' : '（実行中）') : ''
          return (
            <Box key={row.id} flexDirection="column">
              {/* セッションの境目が分かるように、各セッションの1行目だけ薄い水色の背景にする */}
              <Box flexDirection="row" columnGap={1} backgroundColor="#eaf6fc">
                <Box width={nameWidth}>
                  <Text color={BLACK} weight={row.isSelf ? 'bold' : 'regular'} wrap="truncate">{nameTexts[i] ?? row.name}</Text>
                </Box>
                <Box width={idWidth}>
                  <Text color={BLACK}>{row.id}</Text>
                </Box>
                <Box width={destWidth}>
                  <Text color={BLACK} wrap="truncate">{row.dest}</Text>
                </Box>
                <Box width={statusWidth}>
                  <Text color={toneColor(state.tone)} {...(state.tone === 'caution' ? { backgroundColor: CAUTION_BG } : {})} weight="bold">{state.ch}</Text>
                </Box>
                <Box width={barCells}>
                  <Text color={BLACK}>{row.bytes !== null && maxBytes > 0 ? miniBar(row.bytes / maxBytes, barCells) : ' '}</Text>
                </Box>
                <Box width={mbWidth} justifyContent="flex-end">
                  <Text color={BLACK}>{formatMb(row.bytes)}</Text>
                </Box>
              </Box>
              {(ask !== '' || tool !== '') && (
                <Text color={a !== null && a.tool !== null && !a.toolDone ? BLUE : BLACK} wrap="truncate">{'　' + cut(ask + (ask !== '' && tool !== '' ? '　' : '') + tool, detailWidth)}</Text>
              )}
              {row.summary !== null && (
                <Text color={BLACK} wrap="wrap">{'　要約 ' + row.summary}</Text>
              )}
            </Box>
          )
        })}

        <Box marginTop={1}>
          <Text color={BLACK} weight="bold">{snap.feedNote !== '' ? snap.feedNote : 'やり取りを読んでいます…'}</Text>
        </Box>
        {snap.feed.map((item, i) => (
          <Box key={'feed-' + String(i)} flexDirection="row" columnGap={1}>
            <Box width={timeWidth}>
              <Text color={BLACK}>{item.time}</Text>
            </Box>
            <Box width={pairWidth}>
              <Text color={BLACK} weight={item.isUnread === true ? 'bold' : 'regular'} wrap="truncate">{pairText(item)}</Text>
            </Box>
            <Box width={subjectWidth}>
              <Text color={BLACK} wrap="truncate">{(item.kind !== '' && item.kind !== '合図' ? item.kind + ' ' : '') + (item.subject !== '' ? item.subject : ' ')}</Text>
            </Box>
            <Box width={stateWidth}>
              <Text color={item.isUnread === true ? RED : BLACK} weight={item.isUnread === true ? 'bold' : 'regular'}>{item.isUnread === null ? ' ' : item.isUnread ? '未読' : '既読'}</Text>
            </Box>
          </Box>
        ))}
        {talkBlock}
        {snap.error !== null && <Text color={RED}>{snap.error}</Text>}
        <Text color={BLACK}>{'更新 ' + formatTime(snap.updatedAt) + '　大きさは2秒・様子とやり取りは5秒・要約は変化があれば3分ごと。閉じたら /sessions'}</Text>
      </Box>
    )
  })
}
