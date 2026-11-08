// 10秒ごとに セッション表.py を回して、表の材料（名前・状態・圧縮回数・ログの大きさ・最後の答え）を取り直す
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { SessionRow } from '../../types'
import { EMPTY, isRow, join, normalize } from './共通'
import { summarizeNext } from './要約する'

const snapshot = atom({ plugin: 'session-list', key: 'snapshot' } as const, EMPTY)

// 表の数字を新しくする間隔。ペインが開いている間だけ動く。
// 全セッションで表が開くので、2秒ごとだと 11セッションで PC のコア3つ分がふさがる。10秒ごとにしてコア0.6個分に抑える（私の指示 g、2026-10-24）
export const EVERY_MS = 10000

let isBusy = false
let lastKey = ''
// セッション表.py に渡す、生ログごとの読み終えた位置・圧縮回数・名前・最後の答え
let scanMemo: Record<string, unknown> = {}

// 変わっていなければ描き直さない
async function refresh($: EngineInterface): Promise<void> {
  const script = join($.plugin.root, 'tools', 'セッション表.py')
  let error: string | null = null
  let rows: SessionRow[] | null = null
  try {
    const ran = await $.process.run(['python', '-X', 'utf8', script], { stdin: JSON.stringify(scanMemo), timeoutMs: 20000 })
    if (ran.exitCode !== 0) {
      error = 'セッション表.py が失敗しました（exit ' + ran.exitCode + '）: ' + ran.stderr.trim().slice(0, 200)
    } else {
      const parsed = JSON.parse(ran.stdout) as { rows?: unknown; cache?: unknown }
      rows = Array.isArray(parsed.rows) ? parsed.rows.filter(isRow) : []
      if (typeof parsed.cache === 'object' && parsed.cache !== null) scanMemo = parsed.cache as Record<string, unknown>
    }
  } catch (caught) {
    error = 'セッション表.py を読めません: ' + String(caught)
  }
  const key = JSON.stringify([rows, error])
  if (key === lastKey) return
  lastKey = key
  const now = await $.clock.now()
  await update($, snapshot, prev => {
    const before = normalize(prev)
    return rows === null ? { ...before, error } : { rows, updatedAt: now, error }
  })
}

// 10秒ごとの1回分。前の回がまだ動いていたら飛ばす
export async function tick($: EngineInterface): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    await refresh($)
  } finally {
    isBusy = false
  }
  // 答えが変わったセッションを1つずつ AI で要約する（待たずに次へ進む）
  void summarizeNext($, normalize(await read($, snapshot)).rows).catch(() => undefined)
}
