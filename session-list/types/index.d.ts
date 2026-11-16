// 表の1行（1セッション）
export type SessionRow = {
  // セッションID（全桁）
  id: string
  // 表に出す名前。名前の無いセッションは「（名前なし）」
  name: string
  // 作業中・待機中・確認待ち（ほかの値は登録ファイルの値のまま）
  status: string
  // 圧縮の回数（生ログの compact_boundary の行の数）
  compactions: number
  // 生ログの大きさ（バイト）。生ログが見つからなければ -1
  bytes: number
  // そのセッションの AI の最後の答えの終わり（g を求めているかを見る）
  answer?: string
  // そのセッションの最後の答えの要約（最初の太字の題名。無ければ最初の行）
  summary?: string
  // SendMessage の宛先名（登録ファイルの名前）
  address?: string
  // そのセッションに届いた連絡（送り主の宛先名、本文の頭、届いた時刻のミリ秒）。新しいものから30件まで
  inbox?: Inbox[]
  // セッションの起動元（登録ファイルの entrypoint）。claude-vscode なら VS Code のタブ
  entrypoint?: string
}

export type Inbox = { from: string; text: string; at: number }

// AI の要約。key はどの答えの要約か（答えの指紋）、text は要約の見出し（失敗したら空）。
// isDone は、AI がその答えを「作業を一区切り終えた報告」と判断したか（11/15。状態の【完】に使う。失敗したときと、前の版の控えには無い）
export type Summary = { key: string; text: string; isDone?: boolean }

// ペインが描く材料。updatedAt は最後に読み直した時刻（ミリ秒）、error は直前の読み直しの失敗の理由
export type Snapshot = {
  rows: SessionRow[]
  updatedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    // sendCount は送った回数（入力ボックスを空に戻すため）、sendNote は送った結果の1行
    // openTeams は、やり取りを開いているチーム。setWanted は /session-set のペインを開いておきたいか
    // showAll は、ペインに入りきらない行も全部出しているか（11/14。見出しの行の「ほか N を開く」を押すと true）
    // openTails（要約を押して行の下に開いた欄。11/08）は、11/15 に欄ごと無くした
    'session-list': { snapshot: Snapshot; paneWanted: boolean; setWanted: boolean; sendCount: number; sendNote: string; openTeams: string[]; summaries: Record<string, Summary>; showAll: boolean }
  }
}
