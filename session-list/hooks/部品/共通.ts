// 部品のあいだで分け合う決まり（ペインの名前、色、表の1行の形の確かめ）
// 覚えておく値（atom）は、読み書きするファイルの中に書く決まりなので、ここには置かない
import type { SessionRow, Snapshot } from '../../types'

// ペインの名前（id は英数字だけ。題名は日本語でよい）
export const PANE = 'session-list'
export const TITLE = 'セッションリスト'
export const COMMAND = 'session-list'
// リストと通信の1枚（/session-set）。表はこの mod が描き、下の矢印の図は セッション間通信MOD が足す
export const SET_PANE = 'session-set'
export const SET_TITLE = 'セッションリストと通信'
export const SET_COMMAND = 'session-set'

// 色（黒い文字。このセッションの行は薄い橙、見出しの行は薄い水色。状態の丸は、作業中が青、確認待ちが赤、待機中が緑）
export const BLACK = '#000000'
export const BLUE = '#1f6fb2'
export const RED = '#c00000'
export const GREEN = '#2e7d32'
export const SELF_FILL = '#ffe4c4'
export const HEAD_FILL = '#eaf6fc'

// 表の材料の最初の値
export const EMPTY: Snapshot = { rows: [], updatedAt: 0, error: null }

// 読み直しで消えてよい控え（このセッションのID、2つのペインがそれぞれ開いているか）
export const live = { selfId: '', isPaneOpen: false, isSetOpen: false }

export function join(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

export function isRow(value: unknown): value is SessionRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && typeof row.name === 'string' && typeof row.status === 'string' &&
    typeof row.compactions === 'number' && typeof row.bytes === 'number' &&
    (row.answer === undefined || typeof row.answer === 'string') &&
    (row.summary === undefined || typeof row.summary === 'string') &&
    (row.address === undefined || typeof row.address === 'string') &&
    (row.inbox === undefined || Array.isArray(row.inbox)) &&
    (row.entrypoint === undefined || typeof row.entrypoint === 'string')
}

// $.state は読み直しをまたいで残るので、前の版の形の値が来ても落ちないようにそろえる
export function normalize(stored: unknown): Snapshot {
  const s = (typeof stored === 'object' && stored !== null ? stored : {}) as Partial<Snapshot>
  return {
    rows: Array.isArray(s.rows) ? s.rows.filter(isRow) : [],
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
    error: typeof s.error === 'string' ? s.error : null,
  }
}

// 全角を2桁と数え、幅に入らない文は末尾を「…」にする
export function cellWidth(text: string): number {
  let used = 0
  for (const ch of text) used += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1
  return used
}

export function fitCells(text: string, cells: number): string {
  if (cellWidth(text) <= cells) return text
  let out = ''
  for (const ch of text) {
    if (cellWidth(out + ch + '…') > cells) break
    out += ch
  }
  return out + '…'
}
