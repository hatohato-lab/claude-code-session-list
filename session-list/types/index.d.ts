// ペインが読む値の型。$.state に置く値は、ここで宣言したものだけ使える。

// セッションの最近の流れの1件（人の依頼・他のセッションからの連絡・他のセッションへの連絡・AI の答え・道具）
export type Entry = {
  at: number | null
  kind: 'ask' | 'peer-in' | 'peer-out' | 'claude' | 'tool'
  // 連絡の相手（peer-in は送り主、peer-out は宛先）。ID の先頭8桁か、分からなければ元の宛先
  who: string
  text: string
  // 道具が続いたときの回数
  times: number
}

// 様子表.py が生ログの末尾から拾う、そのセッションのいまの様子
export type Activity = {
  // 最近の流れ（古い順、最大8件）
  entries: Entry[]
  // 人の最後の指示（頭の部分）と時刻（ミリ秒）
  ask: string | null
  askAt: number | null
  // Claude の最後の返事（頭の部分）と時刻。awaitsUser は返事が「お返事待ち」や問いで終わっているか
  reply: string | null
  replyAt: number | null
  awaitsUser: boolean
  // 最後に使った道具（例「Bash テストを走らせる」）と時刻。toolDone は結果が返ったか
  tool: string | null
  toolAt: number | null
  toolDone: boolean
  // 生ログが最後に書かれてからの秒数
  quietSec: number | null
  // 登録の status が waiting のときの理由（承認・入力など）
  waitingFor: string | null
}

// 在席表.py の1行（名前・ID・宛先名・状態・時刻）に、生ログの大きさ・会話相手・様子・要約を足したもの
export type SessionRow = {
  name: string
  id: string
  dest: string
  status: string
  since: string
  bytes: number | null
  isSelf: boolean
  partner: string | null
  activity: Activity | null
  summary: string | null
}

// やり取りの1行。黒板の連絡（kind は 依頼・報告 など、isUnread は既読か）か、合図（kind は '合図'、isUnread は null）
export type FeedItem = {
  stamp: number
  time: string
  from: string
  to: string
  kind: string
  subject: string
  isUnread: boolean | null
}

// 会話の地図の線1本（直近24時間の、送り主から宛先へのやり取りの回数）
export type Link = {
  from: string
  to: string
  count: number
  // 最後のやり取りの時刻（ミリ秒）。1時間以内なら図の線を濃くする
  last: number
}

// この画面からのやり取りの1件。out は入力欄から送った文、in は【監視画面へ】の付いた返事
export type TalkItem = {
  at: number
  dir: 'out' | 'in'
  peer: string
  text: string
  status: string
}

export type Snapshot = {
  rows: SessionRow[]
  feed: FeedItem[]
  feedNote: string
  links: Link[]
  updatedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-list': {
      snapshot: Snapshot
      // 入力欄の送り先。'self' はこのセッション、それ以外は相手の ID の先頭8桁
      target: string
      // 直前に送った結果の1行
      sendNote: string
      // 送った回数。入力欄を空に戻すために、欄の key に使う
      sendCount: number
      // 会話の地図を出すか（地図の横の「隠す」「出す」で切り替える）
      showMap: boolean
      // この画面からのやり取り（直近の数件）
      talk: TalkItem[]
      // 並べて見るセッション（ID の先頭8桁、3つまで）。空なら最近動いたセッションを自動で選ぶ
      picked: string[]
      // ペインを開いておきたいか（/sessions で true、手で閉じたら false）
      paneWanted: boolean
    }
  }
}
