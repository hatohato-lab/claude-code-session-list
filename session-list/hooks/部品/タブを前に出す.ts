// 「開」のボタンを押したときの動き。押したセッションのタブを、VS Code の一番前に出す。
// 10/18 の指示で「開」のボタンとして作り、11/15 の指示で一度、要約のボタンに移した
// （私の指示「要約のところのクリックをすると開くようにしてください。そして開くボタンは廃止してください」）。
// 同じ日に「開」のボタンへ戻した。VS Code は、押せるボタンの中の字を灰色か青地に白に決めていて、要約を黒い字で出すには、
// 要約をボタンの外に出すことになるため（私の指示「灰色の文字のフォントはやめて下さい全部ですね。黒の濃い字にして下さい」）。
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

// 「開」のボタンを押したとき。ID を写し、タブのセッションならタブを前に出す。
// 表の下の1行は、前に出せなかったとき、写せなかったとき、ターミナルのセッションで前に出すタブが無いときだけ出す。
// うまくいったら、前の行も消す（11/14 の指示「この下に表示されているのはもう表示しなくていいです」）
export async function openRow($: EngineInterface, row: SessionRow, surface: RenderSurface): Promise<void> {
  const copyProblem = await copyId($, row, surface)
  const problems: string[] = []
  if (isTab(row)) {
    const reason = await bringToFront($, row)
    if (reason !== null) problems.push(row.name + ' のタブを前に出せませんでした（' + reason + '）')
  } else {
    problems.push(row.name + ' はターミナルのセッションなので、タブは前に出せません' + (copyProblem === null ? '（ID はコピーしました）' : ''))
  }
  if (copyProblem !== null) problems.push(copyProblem)
  await update($, sendNote, () => (problems.length === 0 ? '' : JSON.stringify({ id: row.id, text: problems.join('。') })))
}
