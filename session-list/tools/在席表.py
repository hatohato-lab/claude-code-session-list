"""在席表: いま開いているセッションの名前、セッションID、SendMessage の宛先名、状態を出す。

読むだけで、何も書き換えない。.key のファイルは開かない。
使い方: python 在席表.py
セッション一覧の mod が15秒ごとに呼ぶ。
"""
import ctypes
import datetime
import glob
import json
import os
import sys

HOME = os.path.expanduser("~")
REGISTRY = os.path.join(HOME, ".claude", "sessions")
LOGS = os.path.join(HOME, ".claude", "projects")
STATUS = {"busy": "作業中", "idle": "待機中"}


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


def spare_names():
    """生ログに名前が無いセッションの名前を、補いのファイルから読む（無ければ空）。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "在席表_名前の補い.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def title(session_id, spare):
    """生ログの最後の customTitle を、セッションの名前として返す。無ければ補いのファイルを見る。"""
    name = ""
    for path in glob.glob(os.path.join(LOGS, "*", session_id + ".jsonl")):
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"customTitle"' in line:
                    try:
                        name = json.loads(line).get("customTitle") or name
                    except ValueError:
                        pass
    return name or spare.get(session_id[:8]) or "（名前なし）"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    rows = []
    spare = spare_names()
    now = datetime.datetime.now()
    for path in glob.glob(os.path.join(REGISTRY, "*.json")):
        try:
            with open(path, encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if not d.get("sessionId") or not alive(d.get("pid", 0)):
            continue
        since = d.get("statusUpdatedAt") or d.get("updatedAt")
        if since:
            at = datetime.datetime.fromtimestamp(since / 1000)
            hm = "{}（{}分前）".format(at.strftime("%m-%d %H:%M"), int((now - at).total_seconds() // 60))
        else:
            hm = "不明"
        rows.append((title(d["sessionId"], spare), d["sessionId"][:8], d.get("name", "不明"),
                     STATUS.get(d.get("status"), d.get("status") or "不明"), hm))
    print("名前 | セッションID | SendMessage の宛先名 | 状態 | その状態になった時刻")
    for row in sorted(rows, key=lambda r: r[0]):
        print(" | ".join(row))
    print("宛先名は、セッションを開き直すと変わる。合図を送る直前に、もう一度このコマンドで確かめる。")
    print("合図を送ってよいのは、待機中になって30分以上の相手。")


if __name__ == "__main__":
    main()
