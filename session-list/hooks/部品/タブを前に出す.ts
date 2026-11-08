// 開くのボタン（10/18 の指示）。押したセッションのタブを、VS Code の一番前に出す。
// VS Code の Claude Code 拡張は、vscode://anthropic.claude-code/open?session=<セッションID> を開くと、
// そのセッションのタブがあれば前に出し、無ければ開く。この URL を、Windows の start で開く。
// 11/08、開くが効かなかった原因が分かった。VS Code のタブのセッションは、拡張から ELECTRON_RUN_AS_NODE=1 を引き継ぐ。
// この変数があると、start が起こした Code.exe が画面なしの Node として動き、--open-url を「bad option」ではねて終わる。
// start は起こした先を待たないので cmd は 0 で終わり、失敗が見えなかった。そこで cmd の中で、start の直前にこの変数を消す。
// 「set 名前=」で変数が消える。& の前に空白を入れると空白1つの値が入って消えないので、続けて書く。
// 11/08 からは、押すと先に ID の全体をクリップボードに入れる（私の指示「開くボタンを押したら自動的にクリップボードに入るように」）。
// タブを前に出すと押した画面が後ろに回るので、写すのを先にする。ターミナルのセッションはタブが無いので、写すだけにする
import { atom, update } from 'claude-code'
import type { EngineInterface, RenderSurface } from 'claude-code'

import type { SessionRow } from '../../types'
import { copyId } from './IDを写す'

// 押した結果の1行（送った結果と同じ欄に出す。JSON で持つ）
const sendNote = atom({ plugin: 'session-list', key: 'sendNote' } as const, '')

export const OPEN_URL = 'vscode://anthropic.claude-code/open?session='

// VS Code のタブで動いているセッションか。ターミナルのセッションは、タブを前に出せない
export function isTab(row: SessionRow): boolean {
  return row.entrypoint === 'claude-vscode'
}

// タブを前に出すコマンド。start の最初の引数は窓の題名なので、空の題名を渡して、URL を題名と取り違えないようにする
export function openArgv(id: string): string[] {
  return ['cmd', '/d', '/c', 'set', 'ELECTRON_RUN_AS_NODE=&', 'start', '', OPEN_URL + id]
}

// タブを前に出す。出せなかったときは、その理由を返す
async function bringToFront($: EngineInterface, row: SessionRow): Promise<string | null> {
  try {
    const ran = await $.process.run(openArgv(row.id), { timeoutMs: 10000 })
    if (ran.exitCode === 0) return null
    return 'exit ' + ran.exitCode + (ran.stderr.trim() !== '' ? '、' + ran.stderr.trim().slice(0, 80) : '')
  } catch (error) {
    return String(error)
  }
}

// 開くを押したとき。ID を写し、タブのセッションならタブを前に出して、結果を表の下の1行に出す
export async function openRow($: EngineInterface, row: SessionRow, surface: RenderSurface): Promise<void> {
  const copied = await copyId($, row, surface)
  let front: string
  if (isTab(row)) {
    const reason = await bringToFront($, row)
    front = reason === null ? row.name + ' のタブを前に出しました' : row.name + ' のタブを前に出せませんでした（' + reason + '）'
  } else {
    front = row.name + ' はターミナルのセッションなので、タブは前に出せません'
  }
  await update($, sendNote, () => JSON.stringify({ id: row.id, text: front + '。' + copied }))
}
