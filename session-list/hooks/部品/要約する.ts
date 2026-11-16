// 各セッションの最後の答えを、小さなモデル（haiku）で、表の1行に収まる見出し（全角20字以内）に要約する（10/18 の指示。11/14 に見出しにした）。
// 答えが変わったセッションだけを、1回に1つずつ、3秒以上あけて呼ぶ。失敗したら、その答えでは呼び直さず、題名のまま出す
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { SessionRow, Summary } from '../../types'

const summaries = atom({ plugin: 'session-list', key: 'summaries' } as const, {} as Record<string, Summary>)

const MODEL = 'haiku'
// 11/14、40字以内の1文から、表の1行に収まる全角20字以内の見出しにした。何の作業かを書かせる
// （私の指示「冒頭の書き出しのところだけ見えただけでは作業が何なのかは大まかにしかわからない」「一行で分かるようにすることって可能だろうか」）。
// 11/15、今の状態は見出しに書かせないことにした。状態は、表が丸の色や g のボタンと同じ判定で決め、【 】で囲んで見出しの前に出す
// （私の指示「ステータスは強調できるように、黒枠のかっこで囲むようにしてください」「先頭につけた方が良いかもしれないね」）。
// AI に書かせると、言い方がそろわず、状態が変わっても要約を作り直すまで古いままになる
// 11/15、見出しの前に「完了」か「途中」の1語を付けさせることにした。作業を一区切り終えた報告か、途中で止まって答えを待っているかは、
// 答えの意味でしか分からないので、ここだけは AI に判断させる（私の指示「チャットの回答の意味合いから、一旦作業が完了している場合は、
// 完了というステータスにしてください」）。確認待ち、作業中、g 待ちは、今までどおり表が決め、AI の判断より先に見る
// 指示を変えたら PROMPT_VERSION を上げる。要約の控えの鍵が変わり、今ある要約が新しい指示で作り直される
const PROMPT_VERSION = '4'
const SYSTEM = [
  'あなたは、ある Claude Code のセッションが何の作業をしているかを、一覧の表の1行に出す見出しにまとめる係です。',
  '題名と、そのセッションの AI が最後に書いた答えの終わりを読み、「完了：見出し」か「途中：見出し」の形の1行だけを返す。',
  '頭の語は、答えの意味から選ぶ。',
  '完了 … 頼まれた作業を一区切り終えて、結果を報告している。次の指示や、感想や、見た結果を待っているだけ。',
  '途中 … 作業の途中で止まっている。続けるには、使う人の答え、判断、承認、情報のどれかが要る。',
  'どちらか迷うときは、途中にする。',
  '見出しは、全角20字以内の見出しにする。何の作業か（作業の対象と、していること）だけを書く。',
  '見出しには、今の状態（g 待ち、返事待ち、確認待ち、作業中、完了など）は書かない。状態は、表が見出しの前に別に出す。',
  '前置き、敬語、記号、引用符、句点は書かない。',
  '例: 完了：セッションリストの要約の直し',
].join('\n')
const GAP_MS = 3000
// AI が指示に反して見出しに付けた状態の語。頭の【 】と、終わりの「、g 待ち」の形だけを外す
const STATE_WORDS = 'g\\s*待ち|お?返事待ち|確認待ち|作業中|待機中|完了'
const STATE_HEAD = new RegExp('^【\\s*(?:' + STATE_WORDS + ')\\s*】\\s*')
const STATE_TAIL = new RegExp('\\s*[、,，]\\s*(?:' + STATE_WORDS + ')$')

let isBusy = false
let lastCall = 0

// 答えの短い指紋。同じ答えかどうかを見分ける。頭に指示の版を付け、指示を変えたら要約を作り直す
export function answerKey(answer: string): string {
  let h = 0
  for (let i = 0; i < answer.length; i++) h = (h * 31 + answer.charCodeAt(i)) | 0
  return 'v' + PROMPT_VERSION + ':' + String(answer.length) + ':' + (h >>> 0).toString(36)
}

// 表に出す要約。その答えの要約ができていればそれを、まだなら題名を返す
export function messageOf(row: SessionRow, stored: unknown): string {
  const map = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, Summary | undefined>
  const one = map[row.id]
  const answer = row.answer ?? ''
  if (one !== undefined && typeof one.text === 'string' && one.text !== '' && one.key === answerKey(answer)) return one.text
  return row.summary ?? ''
}

// AI が返した文を、表に出す見出しに整える。空白を1つにし、末尾の句点を外す（見出しなので句点は付けない）。
// 状態は表が【 】で別に出すので、AI が頭に付けた【状態】と、終わりに付けた「、状態」は外す。
// 頭の【 】は、中が状態の語のときだけ外す。ルールの名前（【見た目】_16 など）で始まる見出しを削らないため
export function headlineOf(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(/。$/, '').replace(STATE_HEAD, '').replace(STATE_TAIL, '').trim()
}

// AI が返した1行を、完了かどうかと、見出しに分ける。頭に「完了：」か「途中：」が無いときは、途中として、全体を見出しにする
// （完了と取り違えると、答えの要る問いが灰色で一番下に回るので、はっきり「完了：」と返したときだけ完了にする）
export function verdictOf(raw: string): { isDone: boolean; text: string } {
  const flat = raw.replace(/\s+/g, ' ').trim()
  const found = /^(完了|途中)\s*[：:]\s*(.*)$/.exec(flat)
  if (found === null) return { isDone: false, text: headlineOf(flat) }
  return { isDone: found[1] === '完了', text: headlineOf(found[2] ?? '') }
}

// AI が、その行の今の答えを「作業を一区切り終えた報告」と判断したか。要約がまだの答えと、失敗した答えは false
export function doneOf(row: SessionRow, stored: unknown): boolean {
  const map = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, Summary | undefined>
  const one = map[row.id]
  return one !== undefined && one.isDone === true && one.key === answerKey(row.answer ?? '')
}

// 要約を押すと行の下に最後の答えの終わり600字が開く欄（11/08）は、11/15 の指示で無くした
// （私の指示「クリックして中身が見えるのは、あまり使わなくなったので、中止してください」）。

// 要約がまだの答えを1つだけ要約する
export async function summarizeNext($: EngineInterface, rows: SessionRow[]): Promise<void> {
  if (isBusy) return
  const now = await $.clock.now()
  if (now - lastCall < GAP_MS) return
  const stored = await read($, summaries)
  const map = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, Summary | undefined>
  const target = rows.find(row => (row.answer ?? '') !== '' && map[row.id]?.key !== answerKey(row.answer ?? ''))
  if (target === undefined) return
  const answer = target.answer ?? ''
  const key = answerKey(answer)
  isBusy = true
  lastCall = now
  let verdict = { isDone: false, text: '' }
  try {
    const prompt = '題名: ' + (target.summary ?? '') + '\n\n答えの終わり:\n' + answer
    const result = await $.model.complete({ model: MODEL, system: SYSTEM, prompt, maxTokens: 120, timeoutMs: 30000 })
    if (result.isAnswered) verdict = verdictOf(result.text)
  } catch {
    verdict = { isDone: false, text: '' }
  } finally {
    isBusy = false
  }
  await update($, summaries, prev => ({ ...(typeof prev === 'object' && prev !== null ? prev : {}), [target.id]: { key, text: verdict.text, isDone: verdict.isDone } }))
}
