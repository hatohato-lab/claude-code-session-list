// ペインの中身を描く。1セッション＝1行の表で、見出しの行を付ける
// 列は左から、チームの線、チームの ■、名前（左に状態の色の丸）、進（g）、開（ID をコピーしてタブを前に出す）、要約（先頭に【 】で囲んだ1文字の状態、続けて最後の報告の要約）
// 10/18、2行や4行のカードにすると分かりづらいとの指示で1行の表に戻した。要約は指示で一番右に置き、字を小さくした
// 10/31、詳しくの列を消し、列名を 進・送・要約 に縮めた（私の指示「詳しくというボタンは使用頻度が非常に低い」「一文字でいい」）
// 11/08、状態の列を名前の左の色の丸にし、ID の列を消して開くで写すようにした（私の指示「一列とるのはもったいないので、名前の所に丸いアイコン」
// 「開くボタンを押したら自動的にクリップボードに入るように」）。要約に載せたときの箱は、表の幅いっぱいで600字にした
// 11/08、待機中で返事を待っていない行（背景が白い行）は出さず、隠した数を表の下に出すことにした（私の指示「表示する必要がない」）
// 11/08、マウスを載せる箱は VS Code で出なかったので、要約を押すと行の下に開く形にした（私の指示「クリックしたら下の方に詳細が出てくる」）。
// 送（入力ボックス）の列は外した（私の指示「送信の列もいらないです。使わないことがわかりました」）
// 11/08、要約のボタンは、青い塗りだとボタンに見えないので、枠線だけの形にし、文字を黒い背景の白い字にした
// （私の指示「青だとちょっとボタンに見えない」「背景黒にしてみたらどうだろうか」）。開くと g のボタンは青のまま
// 11/14、作業中の行の背景を薄い青にした（私の指示「今活動中のセッションはちょっと色が付いた方がいい」
// 「活動中でもどのようになっているかが把握できない」）。このセッションの行は、作業中でも薄い橙のまま
// 11/14、「お返事待ち」と書いて止まった答えも返事待ちと見なし、隠さずに薄い黄色で出すことにした（isWaiting）
// 11/14、表の下の行は、問題が起きたときだけ出すことにした。隠したセッションの数と、g を送れた・開けたという結果は出さない
// 11/15、要約を押すと行の下に600字が開く欄と、開くの列を無くし、要約を押すとタブが前に出る形にした
// （私の指示「クリックして中身が見えるのは、あまり使わなくなったので、中止してください」
// 「要約のところのクリックをすると開くようにしてください。そして開くボタンは廃止してください」）。
// 11/15、状態を【 】で囲み、要約の先頭に黒い太字で出すことにした（stateOf。私の指示「ステータスは強調できるように、黒枠のかっこで囲むようにしてください」
// 「先頭につけた方が良いかもしれないね」）。種類は、確認待ち、g 待ち、返事待ち、作業中の4つ。待機中で返事を待っていない行には付けない
// 11/15、【 】の中を先頭の1文字にした（確、g、返、作。私の指示「括弧の中身は一文字で十分です。幅を取らないで欲しいです」）
// 11/15、灰色の字をやめた（私の指示「灰色の文字のフォントはやめて下さい全部ですね。黒の濃い字にして下さい」
// 「要約のところの説明文が薄い灰色の文字になっています」）。VS Code は、押せるボタンの中の字を、灰色（枠線だけのボタン）か
// 青地に白（ふつうのボタン）のどちらかに決めていて、mod からは黒にできない。そこで要約はボタンをやめて黒い字の文にし、
// ID をコピーしてタブを前に出す動きは「開」のボタンに戻した。見出しの行の「ほか N を開く」も、ふつうのボタンと、黒い字の名前に分けた
// 11/15、g 待ちの行を、このセッションの行より上の一番上に置くことにした（rankOf。私の指示「g で待つリストを優先的に上に表示させるようにしたいです」）
// 11/15、状態に「完」（完了）を足した。要約を作る AI が、最後の答えの意味から、作業を一区切り終えた報告かどうかを判断する。
// 完了の行は、背景を灰色（字は黒）にし、一番下に置く（私の指示「チャットの回答の意味合いから、一旦作業が完了している場合は、
// 完了というステータスにしてください」「完了の場合は灰色かな」）
// チーム（名前の数字を除いた部分が同じセッションが2つ以上）は続けて並べ、左に同じ色の線と ■ を付ける。
// チームの中では、主（直近3時間にチームへ一番多く連絡を出したセッション）を先頭にし、ほかには「└」を付ける。
// チームの先頭の名前を押すと、そのチームの最近のやり取りが、チームの下に開く
// 返事を待っている行は薄い黄色、作業中の行は薄い青、完了の行は灰色、このセッションの行は薄い橙
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { Inbox, SessionRow, Summary } from '../../types'
import { BLACK, BLUE, EMPTY, GREEN, HEAD_FILL, RED, SELF_FILL, fitCells, live, normalize } from './共通'
import { openRow } from './タブを前に出す'
import { asksG, findAsk, pressG, readNote, requestsG } from './文を送る'
import { doneOf, messageOf } from './要約する'

const snapshot = atom({ plugin: 'session-list', key: 'snapshot' } as const, EMPTY)
const sendNote = atom({ plugin: 'session-list', key: 'sendNote' } as const, '')
// やり取りを開いているチーム（チームの名前）
const openTeams = atom({ plugin: 'session-list', key: 'openTeams' } as const, [] as string[])
// AI の要約（メッセージの列に出す）
const summaries = atom({ plugin: 'session-list', key: 'summaries' } as const, {} as Record<string, Summary>)
// ペインに入りきらない行も、全部出しているか（見出しの行の「ほか N を開く」を押すと true。11/14）
const showAll = atom({ plugin: 'session-list', key: 'showAll' } as const, false)

// 列の幅（桁。全角1字は2桁）。メッセージの列は、ほかの列を置いた残りの幅を全部使い、1行に収める（入りきらない分は右端で「…」）
// 名前の列は、左の2桁に状態の丸を置き、残りの14桁に名前を書く
const NAME_CELLS = 16
const DOT_CELLS = 2
const BUTTON_CELLS = 5
// 送（入力ボックス）の列は、11/08 の指示で無くした。ID の列（10/24 の指示）も、11/08 の指示で無くした
// 開くのボタンの列（押すと、ID の全体がクリップボードに入り、そのセッションのタブが VS Code の一番前に出る。10/18 と 11/08 の指示）。
// 11/15 に一度、同じ動きを要約のボタンに移してこの列を無くしたが、同じ日に戻した。要約を黒い字で出すには、要約をボタンの外に出すことになるため
const OPEN_CELLS = 5
// 要約の先頭に出す状態の欄。【確】のように全角3字で6桁（11/15 の指示「括弧の中身は一文字で十分です。幅を取らないで欲しいです」）。
// どの行も同じ幅にして、要約の始まりをそろえる
const STATE_CELLS = 6
// ペインが横に置かれたときに、要約が1行に収まると見なす幅（桁）。これより狭いと、1セッションを2行で描く。
// 要約の左の列と間で28桁、開くの列と間で6桁、状態の欄と間で7桁、全角18字の見出しで36桁。
// 全角20字の見出しは、この幅だと終わりの2文字が切れる。2行にして行の数を倍にするより、1行のままにする
const WIDE_COLUMNS = 78

// チームの色。チームごとに、左の線と ■ をこの色にする
const TEAM_COLORS = ['#2e7d32', '#1565c0', '#6a1b9a', '#ef6c00', '#00838f']
const NO_NAME = '（名前なし）'
// 返事を待っている行の色
const WAIT_FILL = '#fff3c4'
// 作業中の行の色（11/14 の指示）。状態の丸の青と同じ系統で、見出しの行の水色（#eaf6fc）より一段濃くして見分ける
const WORK_FILL = '#d9eefa'
// 完了の行の色（11/15 の指示「完了の場合は灰色かな」）。字は黒のままにし、背景だけを灰色にする（灰色の字は使わない）
const DONE_FILL = '#e0e0e0'
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

// 私の返事を待っているか。確認待ちか、最後の答えで g を求めているか、「お返事待ち」と書いているか、「〜ですか」「〜ますか」と聞いている。
// 「お返事待ち」は 11/14 に足した。「お返事待ちです。…型番を教えてください。」で止まったセッションが、返事待ちと見なされずに隠れていた
// （私の指示「環境セッションがあるはずなのに表示されていない」）。ルール【進め方】_05 の4節で、止まって返事を待つ答えはこの言葉で終わる。
// 「次の指示をお願いします」のように、何も聞いていない待ち方は含めない
function isWaiting(row: SessionRow): boolean {
  if (row.status === '作業中') return false
  if (row.status === '確認待ち' || asksG(row)) return true
  return /お返事待ち|ですか|ますか|[？?]/.test(findAsk(row.answer ?? ''))
}

// 要約の先頭に【 】で囲んで出す状態（11/15 の指示）。種類は5つ。
// 出すのは、状態の名前の先頭の1文字（11/15 の指示「括弧の中身は一文字で十分です。幅を取らないで欲しいです」）。
//   確 … 確認待ち。許可などのダイアログを出して、私の操作を待っている（登録ファイルの status が waiting。赤い丸）
//   作 … 作業中。AI が動いている（status が busy。青い丸）
//   g  … g 待ち。最後の答えが g を求めている（g のボタンが出る行）
//   完 … 完了。作業を一区切り終えて報告している（要約を作る AI が、最後の答えの意味から判断する。done に入っている行）
//   返 … 返事待ち。最後の答えが、文で答える問いで終わっている
// 確、作、g は、表が自分で決め、AI の判断（完）より先に見る。AI が完了と判断しても、g を求めている行は g 待ちのまま。
// 完は、11/15 に足した（私の指示「チャットの回答の意味合いから、一旦作業が完了している場合は、完了というステータスにしてください」）。
// 要約がまだの答えは、完にならない（返事待ちのまま出し、要約ができたら変わる）。
// 待機中で返事を待っていない行（このセッションの行だけが表に出る）には、完了でなければ何も付けない。
// この表で g を押したあと、相手が作業を始めるまでのあいだ（10秒以内）も、何も付けない。g は送ったので、返事待ちではない
function stateOf(row: SessionRow, done: Set<string>): string {
  if (row.status === '確認待ち') return '確'
  if (row.status === '作業中') return '作'
  if (asksG(row)) return 'g'
  if (requestsG(row)) return ''
  if (done.has(row.id)) return '完'
  return isWaiting(row) ? '返' : ''
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

// 表の中のまとまり。チーム（key がチームの名前）か、1行だけのまとまり（key が空）。
// members は、チームの全員（g 待ちで一番上に出した行も含む）。チームのやり取りを開いたときに使う
type Group = { key: string; color: string | undefined; lead: string | null; rows: SessionRow[]; members?: SessionRow[] }

// g 待ちの場所（一番上）に置く行か。最後の答えが g を求めていて、作業中でも確認待ちでもない行。
// この表で g を押したあと、相手が作業を始めるまでのあいだ（10秒以内）の行も入れる。押したとたんに行が下へ動くと、
// 下の行が上に詰まり、続けて押そうとした別の行の g を押し違えるため。相手が作業中になった次の読み直しで、作業中の場所へ動く。
// 確認待ちの行は、答えが g を求めていても、確認待ちの場所に置く（状態の【確】と同じ見方）
function isGTier(row: SessionRow): boolean {
  return row.status !== '確認待ち' && row.status !== '作業中' && requestsG(row)
}

// 行の大事さ。小さいほど上に置く。g 待ち（この表の g のボタンで進められる行）、このセッション、確認待ち、作業中、お返事待ち（文で答える問い）、完了、その他の順。
// 入りきらない行をたたむときに、大事な行が上に残るようにする（11/14 の指示で決めた順）。
// 11/15 に、g 待ちを、このセッションより上の一番上にした（私の指示「g で待つリストを優先的に上に表示させるようにしたいです」）。
// 前は、このセッションが一番上で、g 待ちと確認待ちが同じ大事さだった。このセッションが g 待ちなら、g 待ちとして数える。
// 完了の行（done）は、私の答えを待っていないので、返事待ちより下の一番下に置く
function rankOf(row: SessionRow, self: string, done: Set<string>): number {
  if (isGTier(row)) return 0
  if (row.id === self) return 1
  if (row.status === '確認待ち') return 2
  if (row.status === '作業中') return 3
  if (done.has(row.id)) return 5
  return isWaiting(row) ? 4 : 6
}

// 並べ方。チームも、チームの無いセッションも、中のいちばん大事な行の順（rankOf）に並べる。
// g 待ちの行が一番上で、次が、このセッションのチーム（チームが無ければこのセッションだけ）。
// 同じ大事さなら、このセッションのチーム、ほかのチーム（名前の順）、チームの無いセッション（名前の順）の順。
// チームの中の g 待ちの行は、チームから離して、1行だけのまとまりとして一番上に出す（左の線と ■ は、チームの色のまま残す）。
// チームごと上に動かすと、g 待ちでない仲間が g 待ちの行やこのセッションの行より上に来て、「g 待ちが一番上」にならないため。
// g 待ちどうしでは、このセッションを先にする。
// チームの残りの行は、主、このセッション、大事な行の順で、あとはセッション表.py の並び（名前の順）のまま
function arrange(rows: SessionRow[], self: string, now: number, done: Set<string>): Group[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = teamKey(row.name)
    if (key !== '') counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const isTeam = (key: string) => key !== '' && (counts.get(key) ?? 0) >= 2
  const rank = (row: SessionRow) => rankOf(row, self, done)
  const selfRow = rows.find(row => row.id === self)
  const selfKey = selfRow === undefined ? '' : teamKey(selfRow.name)
  // チームの色は、今までどおり、このセッションのチームを先頭にした名前の順で決める
  const teams = [...counts.keys()].filter(isTeam).sort((a, b) => (a === selfKey ? -1 : b === selfKey ? 1 : a.localeCompare(b)))
  const first: Group[] = []
  // チームから離して一番上に出す、g 待ちの行
  const urgent: Group[] = []
  const rest: Group[] = []
  const placed = new Set<string>()
  if (selfRow !== undefined && !isTeam(selfKey)) {
    first.push({ key: '', color: undefined, lead: null, rows: [selfRow] })
    placed.add(selfRow.id)
  }
  teams.forEach((key, i) => {
    const members = rows.filter(row => teamKey(row.name) === key)
    const color = TEAM_COLORS[i % TEAM_COLORS.length]
    for (const row of members) placed.add(row.id)
    for (const row of members.filter(isGTier)) urgent.push({ key: '', color, lead: null, rows: [row] })
    const stay = members.filter(row => !isGTier(row))
    if (stay.length === 0) return
    // 主が g 待ちで上に出ているあいだは、残りの行に「主」「└」を付けない（主のいない「└」だけが並ぶのを避ける）
    const found = leaderOf(members, now)
    const lead = stay.some(row => row.id === found) ? found : null
    const order = (row: SessionRow) => (row.id === lead ? -1 : rank(row))
    const group = { key, color, lead, rows: stay.sort((a, b) => order(a) - order(b)), members }
    if (key === selfKey) first.push(group)
    else rest.push(group)
  })
  for (const row of rows.filter(one => !placed.has(one.id))) {
    rest.push({ key: '', color: undefined, lead: null, rows: [row] })
  }
  // g 待ちどうしでは、このセッションを先にする
  urgent.sort((a, b) => Number(b.rows[0]?.id === self) - Number(a.rows[0]?.id === self))
  const top = (group: Group) => Math.min(...group.rows.map(rank))
  // sort は同じ値の順を変えないので、同じ大事さなら、このセッション、チームから離した行、ほかのチーム、チームの無いセッションの順が残る
  return [...first, ...urgent, ...rest].sort((a, b) => top(a) - top(b))
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
  const storedSummaries = await read($, summaries)
  // AI が「作業を一区切り終えた報告」と判断した行（状態の【完】、灰色の背景、一番下の並びに使う）。要約がまだの行は入らない
  const done = new Set(shown.filter(row => doneOf(row, storedSummaries)).map(row => row.id))
  const groups = arrange(shown, live.selfId, now, done)
  const note = readNote(await read($, sendNote))
  const storedOpen = await read($, openTeams)
  const open = Array.isArray(storedOpen) ? storedOpen : []
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

  // ペインが横（会話の横）に置かれているか。VS Code は、画面の幅が 800px 以上だと横（dock）、未満だと入力欄の上（inline）に置く。
  // 置き場所は画面の側が決め、mod からは選べない。横はペインの幅が狭く、1行のままだと要約が数文字で切れるので、2行で描く。
  // 横には、入力欄の上のような12行分の高さの上限が無いので、2行にしても全部のセッションが見える
  // （11/14 の指示「フレームを広げると横表示になってしまいますね」「下に表示しないと説明文要約文が見れないです」）。
  // ただし2行にすると行の数が倍になり、セッションが多いと縦のスクロールが出る（11/14 の画面写真では、ペインの高さが29行分で、16セッションの2行は33行）。
  // そこで、横でも幅が広くて要約が1行に収まるとき（ペインの縁をつかんで広げたとき）は、1行のままにする
  const isTwoLine = e.props.placement === 'dock' && e.props.bodyColumns < WIDE_COLUMNS

  // ペインに入りきらない行は、たたむ（11/14 の指示「スクロールが発生しないようにしたいです」）。
  // VS Code の入力欄の上のペインは、本文が12行分までで、mod からは広げられない。上下の余白があるので、実際に入るのは11行。
  // そこで、ペインの行数（bodyRows）から、余白の1行と見出しの1行を引いた分だけ、大事な順（arrange）に行を出す。
  // 残りは、見出しの行の右の「ほか N を開く」のボタンにまとめ、押すと全部出す（そのときは縦のスクロールが出る）。
  // bodyRows が 0（まだ測れていない）のときは、入りきらない行はたたまない。
  // 完了の行（状態が【完】の行）は、ペインに入るときも、全部たたむ（11/15 の指示「できれば、完成したものは全部畳んで欲しい」）。
  // 入りきらない分だけをたたむ作りでは、17行のうち7行しかたたまれず、完了の行が3行、表に出たままだった。
  // このセッションの行は、完了でもたたまない
  const room = e.props.scroll.bodyRows
  const capacity = room > 0 ? Math.max(1, Math.floor((room - 2) / (isTwoLine ? 2 : 1))) : Number.POSITIVE_INFINITY
  const isDoneRow = (row: SessionRow) => row.id !== live.selfId && stateOf(row, done) === '完'
  const isAll = (await read($, showAll)) === true
  let left = isAll ? Number.POSITIVE_INFINITY : capacity
  const visible: Group[] = []
  const folded: SessionRow[] = []
  for (const group of groups) {
    const keep: SessionRow[] = []
    for (const row of group.rows) {
      if (isAll || (!isDoneRow(row) && left > 0)) {
        keep.push(row)
        left -= 1
      } else {
        folded.push(row)
      }
    }
    if (keep.length > 0) visible.push({ ...group, rows: keep })
  }
  // 「ほか N を開く」「たたむ」のボタンを出すか。たたむ行（完了の行か、入りきらない行）が1つでもあれば出す
  const rest = groups.reduce((n, group) => n + group.rows.filter(row => !isDoneRow(row)).length, 0)
  const isOver = rest > capacity || groups.some(group => group.rows.some(isDoneRow))

  const drawRow = (group: Group, row: SessionRow, index: number) => {
    const isSelf = row.id === live.selfId
    const dot = statusDot(row.status)
    const prefix = group.key === '' || group.lead === null ? '' : row.id === group.lead ? '主 ' : '└ '
    const label = fitCells(prefix + row.name, NAME_CELLS - DOT_CELLS)
    const stateWord = stateOf(row, done)
    // 行の背景。このセッションは薄い橙、完了は灰色、返事待ちは薄い黄色、作業中は薄い青。
    // 完了の行は、問いで終わっていても、返事待ちの黄色ではなく灰色にする（11/15 の指示「完了の場合は灰色かな」）
    const fill = isSelf ? SELF_FILL : stateWord === '完' ? DONE_FILL : isWaiting(row) ? WAIT_FILL : row.status === '作業中' ? WORK_FILL : undefined
    // 名前と要約の字の色。背景に色がある行（このセッション、完了、返事待ち、作業中）は、黒（#000000）にする
    // （11/15 の指示「灰色の文字のフォントはやめて下さい全部ですね。黒の濃い字にして下さい」）。
    // 背景に色が無い行は、画面の側の字の色のままにする。暗い背景の画面で、黒い字が読めなくなるため
    const textColor = fill === undefined ? undefined : BLACK
    const bar = (
      <Box key={row.id + '-bar'} width={1} flexShrink={0} backgroundColor={group.color}>
        <Text> </Text>
      </Box>
    )
    const mark = (
      <Box key={row.id + '-mark'} width={2} flexShrink={0} flexDirection="column" justifyContent="center">
        <Text color={group.color}>{group.color === undefined ? ' ' : '■'}</Text>
      </Box>
    )
    const name = (
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
    )
    const go = (
      <Box key={row.id + '-button'} width={BUTTON_CELLS} flexShrink={0} flexDirection="column" justifyContent="center" alignItems="center">
        {asksG(row) && <Button key={'g-' + row.id} label="g" onPress={() => void pressG($, row)} />}
      </Box>
    )
    // 開くのボタン。押すと、そのセッションの ID の全体をコピーし、VS Code のタブならそのタブを前に出す（openRow）。
    // g と同じ、VS Code のふつうのボタン（テーマの青地に白い字）にする。枠線だけのボタン（dimColor）は、中の字が灰色になるので使わない
    const opener = (
      <Box key={row.id + '-open'} width={OPEN_CELLS} flexShrink={0} flexDirection="column" justifyContent="center" alignItems="center">
        <Button key={'open-' + row.id} label="開" onPress={press => void openRow($, row, press.surface)} />
      </Box>
    )
    // 状態の欄。先頭の1文字を【 】で囲み、黒い太字で、要約の左に出す（11/15 の指示）。
    // 幅はどの行も同じにして、要約の始まりをそろえる。状態が無い行は、空のまま幅だけ取る
    const state = (
      <Box key={row.id + '-state'} width={STATE_CELLS} flexShrink={0}>
        {stateWord !== '' && <Text bold color={BLACK} wrap="truncate-end">{'【' + stateWord + '】'}</Text>}
      </Box>
    )
    // 要約は、押せない文で、名前と同じ字の色（背景に色がある行は黒）で出す。要約の文を切るのは内側の箱だけにする。
    // 11/15 の朝までは押せるボタンだった。VS Code の画面は、ボタンの中身を文字だけにして mod の色の指定を捨て、
    // 字の色を、枠線だけのボタンでは灰色、ふつうのボタンでは青地に白に決める（拡張機能 2.1.325 の画面のコードで確かめた）。
    // ボタンのままでは黒い字にできないので、ボタンをやめ、押したときの動きは「開」のボタン（opener）に戻した
    const summary = (
      <Box key={row.id + '-summary'} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Text color={textColor} size="caption" wrap="truncate-end">{messageOf(row, storedSummaries)}</Text>
      </Box>
    )
    // 横に置かれて幅が狭いときは、1セッションを2行で描き、2行目に状態と要約をペインの幅いっぱいで出す。チームの線は2行とも通す
    if (isTwoLine) {
      return (
        <Box key={'row-' + row.id} flexDirection="row" flexWrap="nowrap" gap={1} alignItems="stretch" backgroundColor={fill}>
          {bar}
          <Box key={row.id + '-lines'} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Box key={row.id + '-top'} flexDirection="row" flexWrap="nowrap" gap={1} alignItems="stretch">
              {mark}
              {name}
              {go}
              {opener}
            </Box>
            <Box key={row.id + '-message'} minWidth={0} paddingLeft={3} flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center">
              {state}
              {summary}
            </Box>
          </Box>
        </Box>
      )
    }
    return (
      <Box key={'row-' + row.id} flexDirection="row" flexWrap="nowrap" gap={1} alignItems="stretch" backgroundColor={fill}>
        {bar}
        {mark}
        {name}
        {go}
        {opener}
        <Box key={row.id + '-message'} flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center">
          {state}
          {summary}
        </Box>
      </Box>
    )
  }

  // チームの最近のやり取り（新しい順に8件まで）。時刻、送り主 → 受け手、本文の頭。
  // g 待ちで一番上に出した行とのやり取りも入れるので、チームの全員（members）で調べる
  const drawTalk = (group: Group) => {
    const talk = teamTalk(group.members ?? group.rows, now, null).slice(0, TALK_SHOWN)
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
          <Text bold color={BLACK}>開</Text>
        </Box>
        {/* 2行で描くときは、要約は名前の下の行に出るので、見出しの行に「要約」を置かない。
            入りきらない行があるときは、見出しの行の右に、たたんだ行の数のボタンと、たたんだ行の名前を置く（行を増やさないため、見出しの行に置く）。
            名前はボタンの外に黒い字で出す。ボタンの中に入れると、VS Code では字の色を mod から決められない（11/15 の指示「灰色の文字のフォントはやめて下さい全部ですね」） */}
        <Box key="head-message" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row" flexWrap="nowrap" gap={1}>
          {!isTwoLine && <Text bold color={BLACK}>要約</Text>}
          {isOver && (
            <Button
              key="more"
              label={isAll ? 'たたむ' : 'ほか' + String(folded.length) + 'を開く'}
              onPress={() => void update($, showAll, value => !(value === true))}
            />
          )}
          {isOver && !isAll && (
            <Box key="more-names" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text color={BLACK} wrap="truncate-end">{'（' + folded.map(row => row.name).join('、') + '）'}</Text>
            </Box>
          )}
        </Box>
      </Box>
      {visible.map(group => (
        <Box key={'group-' + (group.key !== '' ? group.key : group.rows[0]?.id ?? '')} flexDirection="column">
          {group.rows.map((row, index) => drawRow(group, row, index))}
          {group.key !== '' && open.includes(group.key) && drawTalk(group)}
        </Box>
      ))}
      {/* 表の下には、問題が起きたときの行だけを出す（11/14 の指示「この下に表示されているのはもう表示しなくていいです」）。
          隠したセッションの数と、うまくいった結果は出さない。読み直せなかったとき（赤）と、送らなかった・送れなかった・開けなかったときの1行は出す */}
      {snap.error !== null && <Text color={RED}>{snap.error}</Text>}
      {note !== null && <Text color={BLACK}>{note.text}</Text>}
    </Box>
  )
}
