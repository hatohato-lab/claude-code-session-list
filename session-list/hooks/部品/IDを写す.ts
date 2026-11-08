// ID の全体（36文字。黒板の _宛先.json と同じ形）をクリップボードに入れる（10/24 の指示）。
// 11/08 から ID の列は無くし、開くのボタンを押したときに写す（私の指示「開くボタンを押したら自動的にクリップボードに入るように」）。
// セッション間の SendMessage は名前で届くので、ID が要るのは黒板の宛先の登録や、相手の生ログやタブを指すとき
import type { EngineInterface, RenderSurface } from 'claude-code'

import type { SessionRow } from '../../types'

// 写した結果を、表の下の1行に入れる言葉で返す
export async function copyId($: EngineInterface, row: SessionRow, surface: RenderSurface): Promise<string> {
  const result = await $.ui.copy({ text: row.id, surface })
  return result.isCopied ? 'ID をコピーしました（' + row.id + '）' : 'ID をコピーできませんでした（' + result.reason + '）'
}
