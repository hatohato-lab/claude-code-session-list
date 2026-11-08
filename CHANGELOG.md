# 変更履歴

## 2026-11-08
- 名前を、セッション情報（session-info）から セッションリスト（session-list）に変えた。リポジトリも claude-code-session-info から claude-code-session-list に変えた。古い名前の URL は、新しい名前へ飛ぶ。前の名前で入れていたら、入れ直す（README の「前の名前で入れていたとき」）
- session-list v0.22.0。待機中で返事を待っていないセッションは表に出さず、その数だけを表の下に出す
- session-list v0.21.0。開くのボタンを直した（VS Code から引き継いだ ELECTRON_RUN_AS_NODE を消してから start で開く）。状態の列を名前の左の色の丸にした。ID の列を無くし、開くを押すと ID の全体がクリップボードに入るようにした。要約にマウスを載せたときの箱を、表の幅いっぱいの600字にした
- session-list v0.20.0。詳しくの列を消し、列名を 進・送・要約 に縮め、入力欄の見える幅を全角1文字分にした。g のボタンは、相手が作業を始めたら、どの表からも10秒以内に消える
- session-list v0.19.0。/session-set のペインを足した（セッション間通信を入れていれば、表の下に矢印の図が付く）
- session-list v0.18.1 から v0.18.3。表の読み直しを10秒ごとにした。ID の列を足した

## 2026-10-21
- Linux で確かめる GitHub Actions（linux.yml）を足した。手で起動したときだけ動く

## 2026-10-18
- session-info v0.18.0。送る文の欄を狭め、送るボタンを無くした（Enter で送る）。その分、メッセージの列が広くなった
- session-info v0.17.0。開くの列を足した。押すと、そのセッションのタブが VS Code の一番前に来る
- リポジトリの名前を hatohato-mods から claude-code-session-info に変えた。MOD を1つずつ別のリポジトリにしたため。古い名前の URL は、新しい名前へ飛ぶ
- 型の検査に使う `session-info/tsconfig.json` を足した
- session-info v0.16.0 を公開した（セッションの表、チームと主、返事待ちの色、g のボタン、送る文、詳しくのボタン、AI の要約）
