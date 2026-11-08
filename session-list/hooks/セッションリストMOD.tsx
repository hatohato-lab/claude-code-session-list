// セッションリストMOD の入口。読み込んだときの動きと、各部品のつなぎだけを書く
// 部品\表を描く.tsx    表、g のボタン、行ごとの入力ボックス
// 部品\数字を集める.ts  10秒ごとに セッション表.py を回す
// 部品\文を送る.ts      g と、入力ボックスに打った文を送る
// 部品\共通.ts          部品のあいだで分け合う決まり
// ペインは2つ。/session-list はリストだけ（全セッションで自分から開く）、/session-set はリストと通信の1枚（コマンドで開く）。
// /session-set の矢印の図は、セッション間通信MOD が表の下に足す
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { COMMAND, PANE, SET_COMMAND, SET_PANE, SET_TITLE, TITLE, live } from './部品/共通'
import { EVERY_MS, tick } from './部品/数字を集める'
import { drawPane } from './部品/表を描く'

// ペインを開いておきたいか。手で閉じたときだけ false にする（読み直しをまたいで残る）
const paneWanted = atom({ plugin: 'session-list', key: 'paneWanted' } as const, true)
// /session-set のペインを開いておきたいか。/session-set で true、手で閉じたら false
const setWanted = atom({ plugin: 'session-list', key: 'setWanted' } as const, false)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      live.selfId = await $.session.id()
    } catch {
      live.selfId = ''
    }
    try {
      await $.command.register({
        name: COMMAND,
        description: 'セッションリストのペインを開く（いま開いている全セッションを1行ずつの表で見る）',
        immediate: true,
      })
    } catch {
      // 同じ名前のコマンドがあるときは登録しない
    }
    try {
      await $.command.register({
        name: SET_COMMAND,
        description: 'セッションリストと通信のペインを開く（リストの表の下に、セッション間通信MOD が矢印の図を足す）',
        immediate: true,
      })
    } catch {
      // 同じ名前のコマンドがあるときは登録しない
    }
    // 手で閉じていなければ、読み込んだときに自分から開く
    if ((await read($, paneWanted)) !== false) {
      live.isPaneOpen = true
      void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
      void tick($)
    }
    // /session-set のペインは自分からは開かない。/session-set で開いてあれば、読み直しのあとも開き直す
    if ((await read($, setWanted)) === true) {
      live.isSetOpen = true
      void $.ui.open({ id: SET_PANE, title: SET_TITLE }).catch(() => undefined)
      void tick($)
    }
    $.clock.every(EVERY_MS, () => {
      if (live.isPaneOpen || live.isSetOpen) void tick($)
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    live.isPaneOpen = true
    await update($, paneWanted, () => true)
    // 前に出す指定（focus）を付ける。付けないと、ほかの mod のペインの後ろのタブに開いたままになる
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    void tick($)
    if (!opened.isPlaced) return { text: 'セッションリストのペインを置けませんでした: ' + opened.reason }
    return {}
  })

  on('command.run', { command: SET_COMMAND }, async $ => {
    live.isSetOpen = true
    await update($, setWanted, () => true)
    const opened = await $.ui.open({ id: SET_PANE, title: SET_TITLE, focus: true })
    void tick($)
    if (!opened.isPlaced) return { text: 'セッションリストと通信のペインを置けませんでした: ' + opened.reason }
    return {}
  })

  // 開いておきたいのに置かれていないペインは、使っている人の入力のついでに開き直す
  on('prompt.submit', async ($, e, next) => {
    if (live.isPaneOpen || live.isSetOpen) {
      const panes = await $.ui.panes()
      const isPlaced = (id: string) => panes.some(pane => pane.id === id && pane.isPlaced)
      if (live.isPaneOpen && !isPlaced(PANE)) await $.ui.open({ id: PANE, title: TITLE })
      if (live.isSetOpen && !isPlaced(SET_PANE)) await $.ui.open({ id: SET_PANE, title: SET_TITLE })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    live.isPaneOpen = false
    // 手で閉じたときだけ「開かない」を覚える。読み直しで閉じたときは、次の読み込みで開き直す
    if (e.origin.kind === 'person') await update($, paneWanted, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: SET_PANE }, async ($, e, next) => {
    live.isSetOpen = false
    if (e.origin.kind === 'person') await update($, setWanted, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
  // /session-set のペインも同じ表を描く。下の矢印の図は、この mod より外側で描く セッション間通信MOD が足す
  on('ui.render', { component: 'Pane', requestId: SET_PANE }, async ($, e) => drawPane($, e))
}
