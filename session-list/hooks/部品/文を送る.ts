// g と、入力ボックスに打った文を送る。このセッションなら使っている人の発言として入れ、他のセッションならそのセッションへ届ける
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { SessionRow } from '../../types'
import { fitCells, live } from './共通'

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

// そのセッションの AI が、最後の答えで g を求めているか。押したあとは、答えが変わるまで求めていない扱いにする。
// 作業中のセッションにも出さない。押した表の控え（answeredWith）はほかのセッションの表に伝わらないので、
// g を受け取った相手が作業を始めたら、どの表からも次の読み直し（10秒以内）で消えるようにする（10/31 の指示「即座に他のセッションも反映」）
export function asksG(row: SessionRow): boolean {
  const answer = row.answer ?? ''
  if (answer === '' || row.status === '作業中' || answeredWith[row.id] === answer) return false
  return /\bg\b|「g」/.test(findAsk(answer))
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
  let note: string
  if (row.id === live.selfId) {
    // Claude が作業中なら、手が空いたら始まる。始まるまで待たない
    void $.prompt.submit({ text: body, asUser: true }).catch(() => undefined)
    note = row.name + ' へ「' + fitCells(body, 20) + '」を入れました'
  } else {
    try {
      const sent = await $.session.send({ to: { sessionId: row.id }, text: body })
      note = sent.isDelivered
        ? row.name + ' へ「' + fitCells(body, 20) + '」を送りました'
        : row.name + ' へ送れませんでした（' + (sent.reason ?? '理由不明') + '）'
    } catch (error) {
      note = row.name + ' へ送れませんでした（' + String(error) + '）'
    }
  }
  await update($, sendNote, () => JSON.stringify({ id: row.id, text: note }))
  await update($, sendCount, n => n + 1)
}

// g のボタン。押したら、その答えには答え済みとして g を隠す。
// ほかのセッションへは、ルール【進め方】_09 の3節の印と時刻を付ける（相手がルールを探せるように。時刻は、同じ文が続けて捨てられないように）
export async function pressG($: EngineInterface, row: SessionRow): Promise<void> {
  answeredWith[row.id] = row.answer ?? ''
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
