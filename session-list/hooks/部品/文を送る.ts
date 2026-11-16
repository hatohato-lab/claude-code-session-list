// g と、入力ボックスに打った文を送る。このセッションなら使っている人の発言として入れ、他のセッションならそのセッションへ届ける
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { SessionRow } from '../../types'
import { join, live } from './共通'

// 送った回数（入力ボックスを空に戻すため）と、送った結果（どのセッションのカードに出すかと、その1行。JSON で持つ）
const sendCount = atom({ plugin: 'session-list', key: 'sendCount' } as const, 0)
const sendNote = atom({ plugin: 'session-list', key: 'sendNote' } as const, '')

// g を押したときの、そのセッションの最後の答え。答えが変わるまで、その行の g を出さない
const answeredWith: Record<string, string> = {}

// 最後の答えから、問いかけの1行を取り出す。下から探し、お返事待ち・〜ですか・〜ください・g を含む行を選ぶ
export function findAsk(answer: string): string {
  const lines = answer
    .split('\n')
    .map(line => line.replace(/\*\*|`/g, '').replace(/^\s*(#+|>|-|\d+\.)\s*/, '').trim())
    .filter(line => line !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (/お返事待ち|ですか|ますか|ください|[？?]|\bg\b/.test(line)) return line
  }
  return ''
}

// 最後の答えの問いかけの行が、g を求めているか。この表で g を押したかどうかと、今の状態は見ない
// （11/15。g を押したあと、相手が作業を始めるまでのあいだを、状態の【返事待ち】と取り違えないために分けた）
export function requestsG(row: SessionRow): boolean {
  const answer = row.answer ?? ''
  return answer !== '' && /\bg\b|「g」/.test(findAsk(answer))
}

// そのセッションの AI が、最後の答えで g を求めているか。押したあとは、答えが変わるまで求めていない扱いにする。
// 作業中のセッションにも出さない。押した表の控え（answeredWith）はほかのセッションの表に伝わらないので、
// g を受け取った相手が作業を始めたら、どの表からも次の読み直し（10秒以内）で消えるようにする（10/31 の指示「即座に他のセッションも反映」）
export function asksG(row: SessionRow): boolean {
  if (row.status === '作業中' || answeredWith[row.id] === (row.answer ?? '')) return false
  return requestsG(row)
}

// 送った結果を、そのセッションのカードに出すために読む
export function readNote(stored: unknown): { id: string; text: string } | null {
  if (typeof stored !== 'string' || stored === '') return null
  try {
    const parsed = JSON.parse(stored) as { id?: unknown; text?: unknown }
    return typeof parsed.id === 'string' && typeof parsed.text === 'string' ? { id: parsed.id, text: parsed.text } : null
  } catch {
    return null
  }
}

export async function sendText($: EngineInterface, row: SessionRow, text: string): Promise<void> {
  const body = text.trim()
  if (body === '') return
  // 表の下の1行は、送れなかったときだけ出す。送れたら、前の行も消す
  // （11/14 の指示「この下に表示されているのはもう表示しなくていいです」。前は「〇〇 へ「g」を入れました」と出していた）
  let problem: string | null = null
  if (row.id === live.selfId) {
    // Claude が作業中なら、手が空いたら始まる。始まるまで待たない
    void $.prompt.submit({ text: body, asUser: true }).catch(() => undefined)
  } else {
    try {
      const sent = await $.session.send({ to: { sessionId: row.id }, text: body })
      if (!sent.isDelivered) problem = row.name + ' へ送れませんでした（' + (sent.reason ?? '理由不明') + '）'
    } catch (error) {
      problem = row.name + ' へ送れませんでした（' + String(error) + '）'
    }
  }
  await update($, sendNote, () => (problem === null ? '' : JSON.stringify({ id: row.id, text: problem })))
  await update($, sendCount, n => n + 1)
}

// 押した瞬間の、相手の今の状態と最後の答え（セッション表.py の --now）。読めなければ、その理由の文
type Now = { status: string; answer: string }

async function readNow($: EngineInterface, id: string): Promise<Now | string> {
  const script = join($.plugin.root, 'tools', 'セッション表.py')
  try {
    const ran = await $.process.run(['python', '-X', 'utf8', script, '--now', id], { timeoutMs: 20000 })
    if (ran.exitCode !== 0) return 'セッション表.py が失敗しました（exit ' + ran.exitCode + '）'
    const parsed = JSON.parse(ran.stdout) as { status?: unknown; answer?: unknown }
    if (typeof parsed.status !== 'string' || typeof parsed.answer !== 'string') return '答えの形が違います'
    return { status: parsed.status, answer: parsed.answer }
  } catch (caught) {
    return String(caught)
  }
}

// g を送らない理由。送ってよければ null。
// 表は10秒ごとにしか読み直さないので、そのあいだに相手が作業を始めたり（テキストボックスに g を打ったときなど）、
// 新しい答えを出したりしていることがある。そのまま送ると、g が2回届くか、まだ読んでいない新しい問いに g が届く
// （11/14 の指示「自分のテキストボックスで g を押した場合は、ボタン消えないですよね。だから不整合が生じる」）
function holdReason(row: SessionRow, now: Now | string): string | null {
  if (typeof now === 'string') return '今の状態を確かめられなかった（' + now + '）'
  if (now.status === '閉じている') return '閉じていた'
  if (now.status === '作業中') return 'もう作業を始めていた'
  if (now.answer !== (row.answer ?? '')) return '新しい答えを出していた'
  return null
}

// g のボタン。押したら、その答えには答え済みとして g を隠す。
// 送る前に、相手の今の状態と最後の答えを読み直し、作業中、新しい答え、閉じている、のどれかなら送らずに理由を出す。
// ほかのセッションへは、ルール【進め方】_09 の3節の印と時刻を付ける（相手がルールを探せるように。時刻は、同じ文が続けて捨てられないように）
export async function pressG($: EngineInterface, row: SessionRow): Promise<void> {
  answeredWith[row.id] = row.answer ?? ''
  const reason = holdReason(row, await readNow($, row.id))
  if (reason !== null) {
    await update($, sendNote, () => JSON.stringify({ id: row.id, text: row.name + ' は' + reason + 'ので、g を送りませんでした' }))
    return
  }
  if (row.id === live.selfId) {
    await sendText($, row, 'g')
    return
  }
  const at = new Date(await $.clock.now())
  const pad = (n: number) => String(n).padStart(2, '0')
  // 時刻は秒まで付ける。分までだと、同じ分のうちに続けて押した g が同じ文として相手の受け箱で捨てられた（10/18）
  const stamp = pad(at.getHours()) + ':' + pad(at.getMinutes()) + ':' + pad(at.getSeconds())
  await sendText($, row, 'g（表の g ボタン ' + stamp + '。ルール【進め方】_09 の3節）')
}
