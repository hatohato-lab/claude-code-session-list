"""合図表: 動いているセッションの生ログから、SendMessage の合図（誰から誰へ・いつ）を拾って JSON で出す。

読むだけで、何も書き換えない。.key のファイルは開かない。
使い方: python 合図表.py [前回の読み位置の JSON]
  読み位置は {"f0c2eea6": 34054614} の形（ID の先頭8桁 → 前回読み終えたバイト位置）。
  引数が "-" なら標準入力から読む。省けば各ログを最初から読む（以後は増えた分だけ読めば軽い）。
出力（1行の JSON）:
  {"offsets": {"f0c2eea6": 34060000},
   "bells": [{"at": "2026-10-17T00:15:03+09:00", "from": "f0c2eea6", "to": "73662b12",
              "via": "paired", "key": "3f2a9c1e5b7d4e8a", "text": "黒板に書きました。読んでください。"}]}
  from と to は、生きているセッションなら ID の先頭8桁。分からなければ、相手の名乗った名前か
  「終了したセッション」「別の端末のセッション」。直近72時間の合図だけを返す。
  via は、送った側の記録だけなら sent、受けた側だけなら received、両方を突き合わせたら paired。
  key は文面から作った印。送った側と受けた側の記録は、同じ key で2分以内なら同じ合図として1つにまとめる。
  サブエージェントの結果の受け渡し（Subagent hand-back）は、セッション間の合図ではないので除く。
セッション一覧の mod が5秒ごとに呼ぶ。
"""
import ctypes
import datetime
import glob
import hashlib
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
REGISTRY = os.path.join(HOME, ".claude", "sessions")
LOGS = os.path.join(HOME, ".claude", "projects")
KEEP_HOURS = 72
PAIR_SECONDS = 120
MERGE_SECONDS = 90
TEXT_LIMIT = 60


def alive(pid):
    """プロセスが生きているかを、問い合わせだけで確かめる（終了はさせない）。"""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name != "nt":
        # Linux と macOS。シグナル 0 は届くかを確かめるだけで、相手には何もしない
        try:
            os.kill(pid, 0)
        except PermissionError:
            return True
        except OSError:
            return False
        return True
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    code = ctypes.c_ulong()
    ok = ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(handle)
    return bool(ok) and code.value == 259


def live_sessions():
    """生きているセッションの登録情報（sessionId・name・messagingSocketPath など）を返す。"""
    rows = []
    for path in glob.glob(os.path.join(REGISTRY, "*.json")):
        try:
            with open(path, encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if not d.get("sessionId") or not alive(d.get("pid", 0)):
            continue
        rows.append(d)
    return rows


def log_path(session_id):
    """同じ ID の生ログが複数のフォルダーにあるときは、いちばん新しく書かれたものを使う。"""
    hits = glob.glob(os.path.join(LOGS, "*", session_id + ".jsonl"))
    if not hits:
        return None
    return max(hits, key=os.path.getmtime)


def parse_time(text):
    """生ログの timestamp（ISO 8601、末尾 Z）を aware な datetime にする。"""
    if not text:
        return None
    try:
        return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def read_offsets(argv):
    if len(argv) < 2:
        return {}
    raw = sys.stdin.read() if argv[1] == "-" else argv[1]
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def squash(text):
    return " ".join(str(text or "").split())


def key_of(text):
    return hashlib.sha1(squash(text)[:300].encode("utf-8")).hexdigest()[:16]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    offsets = read_offsets(sys.argv)
    sessions = live_sessions()
    live_ids = {d["sessionId"][:8] for d in sessions}
    by_pipe = {}
    by_name = {}
    by_bridge = {}
    for d in sessions:
        id8 = d["sessionId"][:8]
        if d.get("messagingSocketPath"):
            by_pipe[d["messagingSocketPath"]] = id8
        if d.get("name"):
            by_name[d["name"]] = id8
        if d.get("bridgeSessionId"):
            by_bridge["bridge:" + d["bridgeSessionId"]] = id8

    # 1回目: 増えた分の行から合図の記録を集め、相手が名乗った名前も覚える
    since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=KEEP_HOURS)
    records = []
    told = {}
    new_offsets = {}
    for d in sessions:
        session_id = d["sessionId"]
        id8 = session_id[:8]
        path = log_path(session_id)
        if not path:
            continue
        size = os.path.getsize(path)
        start = offsets.get(id8, 0)
        if not isinstance(start, int) or start < 0 or start > size:
            start = 0
        with open(path, "rb") as fh:
            fh.seek(start)
            data = fh.read()
        end = data.rfind(b"\n")
        if end < 0:
            new_offsets[id8] = start
            continue
        new_offsets[id8] = start + end + 1
        for raw in data[:end].split(b"\n"):
            if b'"SendMessage"' not in raw and b'"kind":"peer"' not in raw:
                continue
            try:
                row = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            at = parse_time(row.get("timestamp"))
            if at is None or at < since:
                continue
            if row.get("type") == "assistant":
                for block in (row.get("message") or {}).get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == "SendMessage":
                        params = block.get("input") or {}
                        full = params.get("message") or ""
                        records.append({"at": at, "via": "sent", "owner": id8, "address": str(params.get("to") or ""),
                                        "key": key_of(full), "text": params.get("summary") or full})
            elif row.get("type") == "user":
                origin = row.get("origin") or {}
                if origin.get("kind") != "peer" or origin.get("handback") or origin.get("senderTaskId"):
                    continue
                address = str(origin.get("from") or "")
                if address and origin.get("name"):
                    told[address] = origin["name"]
                body = origin.get("body") or ""
                marked = re.search(r"〔送り主:([0-9a-f]{8})〕", body)
                records.append({"at": at, "via": "received", "owner": id8, "address": address,
                                "key": key_of(body), "text": body, "mark": marked.group(1) if marked else None})

    def resolve(address, mark=None):
        # 文面の末尾の「〔送り主:ID〕」があれば、宛先名が変わっていても、その ID を送り主にする
        if mark in live_ids:
            return mark
        if not address:
            return "?"
        bare = address[4:] if address.startswith("uds:") else address
        hit = by_pipe.get(bare) or by_bridge.get(address) or by_name.get(address) or by_name.get(bare)
        if hit:
            return hit
        if address in told:
            return by_name.get(told[address], told[address])
        if "cc-msg-" in address:
            return "終了したセッション"
        if address.startswith("bridge:"):
            return "別の端末のセッション"
        return address

    # 2回目: 送った側と受けた側の記録を、文面の印（key）と時刻で突き合わせる
    bells = []
    sent = [r for r in records if r["via"] == "sent"]
    received = [r for r in records if r["via"] == "received"]
    used = set()
    for s in sent:
        to = resolve(s["address"])
        match = None
        for j, r in enumerate(received):
            if j in used or r["key"] != s["key"]:
                continue
            if abs((r["at"] - s["at"]).total_seconds()) > PAIR_SECONDS:
                continue
            frm = resolve(r["address"], r.get("mark"))
            if (to not in live_ids or to == r["owner"]) and (frm not in live_ids or frm == s["owner"]):
                match = j
                break
        if match is None:
            bells.append({"_at": s["at"], "from": s["owner"], "to": to, "via": "sent", "key": s["key"], "text": s["text"]})
        else:
            used.add(match)
            bells.append({"_at": s["at"], "from": s["owner"], "to": received[match]["owner"], "via": "paired",
                          "key": s["key"], "text": s["text"]})
    for j, r in enumerate(received):
        if j not in used:
            bells.append({"_at": r["at"], "from": resolve(r["address"], r.get("mark")), "to": r["owner"], "via": "received",
                          "key": r["key"], "text": r["text"]})

    # 念のため、同じ組で90秒以内の重なりは1つにまとめる
    bells.sort(key=lambda b: b["_at"])
    out = []
    for b in bells:
        twin = next((o for o in reversed(out) if o["from"] == b["from"] and o["to"] == b["to"]
                     and abs((b["_at"] - o["_at"]).total_seconds()) <= MERGE_SECONDS), None)
        if twin is None:
            out.append(b)
    result = [{"at": b["_at"].astimezone().isoformat(timespec="seconds"), "from": b["from"], "to": b["to"],
               "via": b["via"], "key": b["key"], "text": squash(b["text"])[:TEXT_LIMIT]} for b in out]
    print(json.dumps({"offsets": new_offsets, "bells": result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
