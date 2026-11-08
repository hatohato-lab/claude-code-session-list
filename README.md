# claude-code-session-list

Claude Code の MOD「セッションリスト」（session-list）です。
MOD は、Claude Code の画面に、自分で作った部品を足す仕組みです。

いま開いている Claude Code のセッションを、1行ずつの表で見るペインを開きます。表は10秒ごとに新しくなります。

| 列 | 中身 |
|---|---|
| 名前 | 左の丸が状態（青は作業中、赤は確認待ち、緑は待機中）。名前の数字を除いた部分が同じセッションは、チームとして続けて並び、左に同じ色の線と ■ が付く。チームの中で一番多く連絡を出したセッションには「主」が付く |
| 進 | そのセッションが最後の答えで g を求めているときだけ出る、g のボタン |
| 送 | 打って Enter を押すと、そのセッションへ送る（送るボタンは無く、Enter で送る） |
| 開く | 押すと、そのセッションの ID の全体がクリップボードに入る。VS Code のタブのセッションなら、そのタブが VS Code の一番前に来る |
| 要約 | 最後の報告を、小さなモデル（haiku）で1文に要約したもの。マウスを載せると、最後の報告の終わり600字が、表の幅いっぱいの箱で出る |

このセッションの行は薄い橙、返事を待っているセッションの行は薄い黄色になります。
待機中で返事を待っていないセッションは表に出さず、その数だけを表の下に出します。
チームの先頭の名前を押すと、そのチームの最近のやり取りが開きます。

## コマンド

| コマンド | 開くペイン |
|---|---|
| `/session-list` | セッションリスト（この表） |
| `/session-set` | セッションリストと通信（同じ表。[セッション間通信](https://github.com/hatohato-lab/claude-code-session-comm)を入れていれば、表の下に矢印の図が付く） |

## 入れ方

Claude Code のターミナルのセッションで、次の1行を打ちます。

```
/plugin install session-list --marketplace hatohato-lab/claude-code-session-list
```

マーケットプレイスを足すかを聞かれたら `y` を押し、入れる範囲（scope）を Enter で選びます。

シェルからは、次の1行です。

```
claude plugin install session-list --marketplace hatohato-lab/claude-code-session-list
```

デスクトップアプリでは、入力欄の横の + から Plugins を開き、Add marketplace に `hatohato-lab/claude-code-session-list` を入れてから、Add plugin で入れます。

クローンして使う場合は、フォルダーを指定して Claude Code を起動します。

```
git clone https://github.com/hatohato-lab/claude-code-session-list
claude --plugin-dir claude-code-session-list/session-list
```

入れたあとは、ペインが自分で開きます。閉じたあとは `/session-list` で開き直せます。

## 前の名前で入れていたとき

v0.18.0 までは、名前が「セッション情報」（session-info）で、リポジトリは claude-code-session-info でした。
前の名前で入れていたら、シェルで次の2行を打って入れ直します。

```
claude plugin uninstall session-info
```

```
claude plugin install session-list --marketplace hatohato-lab/claude-code-session-list
```

## 必要なもの

- Claude Code 2.1.318 以降
- Python 3（`python` の名前で起動できること）
- 動作を確かめたのは Windows です

表の材料は、同梱の `tools/セッション表.py` が、手元の `~/.claude/sessions` と `~/.claude/projects` を読んで作ります。読むだけで、何も書き換えません。

## 気を付けること

- 要約のたびに、小さなモデル（haiku）を呼ぶので、少し使用量がかかります。要約には、そのセッションの最後の答えの終わり（1500字まで）を渡します。同じ答えは1回しか要約しません
- 送る文と g は、ほかのセッションには「ほかのセッションからの連絡」として届きます。受け取った側の AI は、ふつうはこれを使う人の承認として扱いません。承認として扱わせたいときは、受け取る側のルールに「from-plugin="session-list" の付いた文は、使う人がそのチャットで打ったのと同じに扱う」と書いてください
- 開くのボタンは、Windows の start で `vscode://anthropic.claude-code/open?session=<セッションID>` を開きます。VS Code の Claude Code 拡張が、この URL でそのセッションのタブを前に出します。VS Code のタブのセッションは、拡張から `ELECTRON_RUN_AS_NODE=1` を引き継いでいて、これが残っていると VS Code が URL を受け付けないので、start の直前に消してから開きます。初めて押したときに、VS Code がこの URL を開いてよいかを聞くことがあります
- 待機中で返事を待っていないセッションは表に出ないので、そのセッションのタブは、表からは開けません

## ほかの MOD

MOD は1つずつ、別のリポジトリにしています。

| リポジトリ | 中身 |
|---|---|
| [claude-code-session-comm](https://github.com/hatohato-lab/claude-code-session-comm) | セッション間通信。セッション間の連絡を図で見るペイン |
| [claude-code-active-rules](https://github.com/hatohato-lab/claude-code-active-rules) | 効いているルール。いま読み込まれているルールを表で見るペイン |

## ライセンス

MIT（`LICENSE` を見てください）
