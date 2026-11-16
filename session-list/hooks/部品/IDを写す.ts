// ID の全体（36文字。黒板の _宛先.json と同じ形）をクリップボードに入れる（10/24 の指示）。
// 11/08 から ID の列は無くし、開くのボタンを押したときに写す（私の指示「開くボタンを押したら自動的にクリップボードに入るように」）。
// 11/15 に一度、開くの列を無くして要約のボタンを押したときに写す形にしたが、同じ日に「開」のボタンへ戻した
// （要約を黒い字で出すために、要約をボタンの外に出した。VS Code は、ボタンの中の字を黒にさせない）。
// セッション間の SendMessage は名前で届くので、ID が要るのは黒板の宛先の登録や、相手の生ログやタブを指すとき
import type { EngineInterface, RenderSurface } from 'claude-code'

import type { SessionRow } from '../../types'

// 写せなかったときだけ、その理由を表の下の1行に入れる言葉で返す。写せたら null
// （11/14 の指示「この下に表示されているのはもう表示しなくていいです」で、うまくいった結果は出さないことにした）
export async function copyId($: EngineInterface, row: SessionRow, surface: RenderSurface): Promise<string | null> {
  const result = await $.ui.copy({ text: row.id, surface })
  return result.isCopied ? null : 'ID をコピーできませんでした（' + result.reason + '）'
}
