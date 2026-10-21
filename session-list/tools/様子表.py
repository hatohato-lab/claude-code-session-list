"""生きている Claude Code セッションごとに、いまの様子を JSON 1行で出す。

~/.claude/sessions/*.json からプロセスが生きているセッションを選び、
~/.claude/projects/*/<sessionId>.jsonl の末尾 2 MiB から、
最後の依頼・返事・道具と、直近のやり取りを拾う。末尾に依頼が無ければ 16 MiB までさかのぼる。
読むだけで、何も書かない。セッション一覧の mod が5秒ごとに呼ぶ。
"""

import ctypes
import datetime
import hashlib
import json
import os
import re
import sys
import time
from urllib.parse import urlsplit

TAIL_BYTES = 2 * 1024 * 1024  # 生ログは末尾だけ読む
LOOKBACK_BYTES = 16 * 1024 * 1024  # 末尾に人の依頼が無いとき、さかのぼって探す上限
CHUNK_BYTES = 4 * 1024 * 1024  # さかのぼるときに1回で読む量
HEAD_CHARS = 100  # ask と reply の文字数
LINE_CHARS = 400  # recent の1行の文字数
RECENT_CHARS = 2500  # recent 全体の文字数
DETAIL_CHARS = 60  # 道具の説明の文字数
ENTRY_CHARS = 160  # entries の1件の文字数
ENTRY_MAX = 8  # entries の件数（新しいものから）
SPACES = re.compile(r"\s+")


def alive(pid):
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


def squash(text):
    """改行を含む空白を、1つの半角空白にまとめる。"""
    return SPACES.sub(" ", text).strip()


def local_time(stamp):
    """ログの時刻（UTC）を、時差つきの現地時刻（秒まで）にする。"""
    if not isinstance(stamp, str):
        return None
    try:
        moment = datetime.datetime.fromisoformat(stamp)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return moment.astimezone().isoformat(timespec="seconds")


def prompt_text(content):
    """人の依頼の本文。「<」で始まる文（コマンドの包み・注意書き）は除く。"""
    if isinstance(content, str):
        texts = [content]
    elif isinstance(content, list):
        texts = [b.get("text") for b in content if isinstance(b, dict) and b.get("type") == "text"]
    else:
        return ""
    return squash(" ".join(t for t in texts if isinstance(t, str) and not t.lstrip().startswith("<")))


def awaits_user(text):
    """返事が人の返事を待つ形（「お返事待ち」を含む、または問いで終わる）か。"""
    return "お返事待ち" in text or text.strip().endswith(("？", "?"))


def tool_detail(name, given):
    """道具の種類ごとに、何をしているかの短い説明を作る。"""
    given = given if isinstance(given, dict) else {}

    def field(key):
        value = given.get(key)
        return value if isinstance(value, str) else ""

    if name in ("Bash", "PowerShell"):
        detail = field("description") or squash(field("command"))[:DETAIL_CHARS]
    elif name in ("Read", "Edit", "Write", "NotebookEdit"):
        path = field("file_path") or field("notebook_path")
        detail = path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    elif name in ("Grep", "Glob"):
        detail = field("pattern")
    elif name == "WebFetch":
        try:
            detail = urlsplit(field("url")).hostname or ""
        except ValueError:
            detail = ""
    elif name == "WebSearch":
        detail = field("query")
    elif name in ("Agent", "Task"):
        detail = field("description")
    elif name == "Skill":
        detail = field("skill")
    elif name.startswith("mcp__"):
        detail = name.rsplit("__", 1)[-1]
    else:
        detail = ""
    return squash(detail)[:DETAIL_CHARS]


def tail_rows(path):
    """末尾 2 MiB を読み、途中で切れた先頭の1行を捨てて、行ごとの JSON と、最初の完全な行の位置を返す。"""
    with open(path, "rb") as f:
        size = f.seek(0, os.SEEK_END)
        start = max(0, size - TAIL_BYTES)
        f.seek(start)
        data = f.read()
    first = start
    if start > 0:
        cut = data.find(b"\n")
        data = data[cut + 1:] if cut >= 0 else b""
        first = start + cut + 1 if cut >= 0 else size
    rows = []
    for line in data.split(b"\n"):
        if not line or line.isspace():
            continue
        try:
            row = json.loads(line)
        except (ValueError, RecursionError):
            continue  # 書きかけの行など
        if isinstance(row, dict):
            rows.append(row)
    return rows, first


def earlier_ask(path, end):
    """位置 end より前を後ろから読み、最後の人の依頼を探す（さかのぼるのは LOOKBACK_BYTES まで）。

    作業中のセッションは、末尾 2 MiB の大半を道具の結果などが占め、依頼が範囲の外に出やすい。
    """
    stop = max(0, end - LOOKBACK_BYTES)
    pos = end
    carry = b""
    with open(path, "rb") as f:
        while pos > stop:
            start = max(stop, pos - CHUNK_BYTES)
            f.seek(start)
            data = f.read(pos - start) + carry
            pos = start
            lines = data.split(b"\n")
            # 先頭の切れ端は、次（より前）に読む分とつなげる
            carry = lines[0] if start > 0 else b""
            body = lines[1:] if start > 0 else lines
            for line in reversed(body):
                if b'"kind":"human"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except (ValueError, RecursionError):
                    continue
                origin = row.get("origin") if isinstance(row, dict) else None
                if row.get("type") != "user" or not isinstance(origin, dict) or origin.get("kind") != "human":
                    continue
                message = row.get("message")
                text = prompt_text(message.get("content") if isinstance(message, dict) else None)
                if text:
                    return {"at": row.get("timestamp"), "text": text[:HEAD_CHARS]}
    return None


def look(path, resolve):
    """生ログの末尾から、最後の依頼・返事・道具と、直近のやり取りを拾う。

    entries は、そのセッションの最近の流れ（人の依頼・他のセッションとの連絡・AI の答え・道具）を古い順に並べたもの。
    道具が続くときは最後の1件にまとめ、times に回数を入れる。
    """
    ask = reply = None
    tool_row = tool_block = None
    is_done = False
    lines = []
    entries = []

    def add(entry):
        if entry["kind"] == "tool" and entries and entries[-1]["kind"] == "tool":
            entry["times"] = entries[-1].get("times", 1) + 1
            entries[-1] = entry
        else:
            entries.append(entry)

    rows, first = tail_rows(path)
    for row in rows:
        kind = row.get("type")
        message = row.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if kind == "user":
            origin = row.get("origin")
            if isinstance(origin, dict) and origin.get("kind") == "peer" and not origin.get("handback") and not origin.get("senderTaskId"):
                body = squash(origin.get("body") or "")
                if body:
                    who = resolve(origin.get("from")) or (origin.get("name") or "")
                    add({"at": row.get("timestamp"), "kind": "peer-in", "who": who, "text": body[:ENTRY_CHARS]})
            if isinstance(origin, dict) and origin.get("kind") == "human":
                text = prompt_text(content)
                if text:
                    ask = {"at": row.get("timestamp"), "text": text[:HEAD_CHARS]}
                    lines.append("依頼: " + text[:LINE_CHARS])
                    add({"at": row.get("timestamp"), "kind": "ask", "text": text[:ENTRY_CHARS]})
            tool_id = tool_block.get("id") if tool_block is not None else None
            if tool_id and not is_done and isinstance(content, list):
                is_done = any(
                    isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id") == tool_id
                    for b in content
                )
        elif kind == "assistant" and isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    text = squash(block["text"])
                    if text:
                        reply = {"at": row.get("timestamp"), "text": text[:HEAD_CHARS], "awaitsUser": awaits_user(block["text"])}
                        lines.append("Claude: " + text[:LINE_CHARS])
                        add({"at": row.get("timestamp"), "kind": "claude", "text": text[:ENTRY_CHARS]})
                elif block.get("type") == "tool_use":
                    tool_row, tool_block, is_done = row, block, False
                    name = block.get("name") if isinstance(block.get("name"), str) else ""
                    given = block.get("input") if isinstance(block.get("input"), dict) else {}
                    if name == "SendMessage":
                        said = given.get("summary") or given.get("message") or ""
                        add({"at": row.get("timestamp"), "kind": "peer-out", "who": resolve(given.get("to")), "text": squash(str(said))[:ENTRY_CHARS]})
                    else:
                        add({"at": row.get("timestamp"), "kind": "tool", "text": (name + " " + tool_detail(name, given)).strip()})

    if ask is None and first > 0:
        ask = earlier_ask(path, first)

    tool = None
    if tool_block is not None:
        name = tool_block.get("name") if isinstance(tool_block.get("name"), str) else ""
        tool = {
            "at": local_time(tool_row.get("timestamp")),
            "name": name,
            "detail": tool_detail(name, tool_block.get("input")),
            "done": is_done,
        }
    for found in (ask, reply):
        if found is not None:
            found["at"] = local_time(found["at"])
    entries = entries[-ENTRY_MAX:]
    for entry in entries:
        entry["at"] = local_time(entry["at"])

    # 直近のやり取りは末尾 2500 文字だけ残し、行の頭で切る
    recent = "\n".join(lines)
    if len(recent) > RECENT_CHARS:
        cut = len(recent) - RECENT_CHARS
        if recent[cut - 1] != "\n":
            newline = recent.find("\n", cut)
            cut = newline + 1 if newline >= 0 else len(recent)
        recent = recent[cut:]
    return {"ask": ask, "reply": reply, "tool": tool, "recent": recent, "entries": entries}


def find_log(folders, session_id):
    """同じ ID の生ログが複数のフォルダーにあれば、最も新しく書かれたものを選ぶ。"""
    best, best_mtime = None, None
    for folder in folders:
        path = os.path.join(folder, session_id + ".jsonl")
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            continue
        if best_mtime is None or mtime > best_mtime:
            best, best_mtime = path, mtime
    return best, best_mtime


def make_resolver(sessions):
    """連絡のあて先（パイプ・宛先名・リモートの ID）を、生きているセッションの ID 先頭8桁にする。分からなければそのまま返す。"""
    by_pipe, by_name, by_bridge = {}, {}, {}
    for info in sessions:
        id8 = info["sessionId"][:8]
        if isinstance(info.get("messagingSocketPath"), str):
            by_pipe[info["messagingSocketPath"]] = id8
        if isinstance(info.get("name"), str):
            by_name[info["name"]] = id8
        if isinstance(info.get("bridgeSessionId"), str):
            by_bridge["bridge:" + info["bridgeSessionId"]] = id8

    def resolve(address):
        if not isinstance(address, str) or not address:
            return ""
        bare = address[4:] if address.startswith("uds:") else address
        return by_pipe.get(bare) or by_bridge.get(address) or by_name.get(address) or by_name.get(bare) or address

    return resolve


def describe(info, folders, resolve):
    """1つのセッションの様子。生ログが無い・読めないときは空の様子で出す。"""
    session_id = info["sessionId"]
    entry = {
        "id": session_id[:8],
        "status": info.get("status"),
        "waitingFor": info.get("waitingFor"),
        "ask": None,
        "reply": None,
        "tool": None,
        "quietSec": None,
        "recent": "",
        "entries": [],
    }
    try:
        path, mtime = find_log(folders, session_id)
        if path is not None:
            seen = look(path, resolve)
            seen["quietSec"] = max(0, int(time.time() - mtime))
            entry.update(seen)
    except Exception:
        pass  # 読めない生ログは、空の様子のまま出す
    entry["recentKey"] = hashlib.sha1(entry["recent"].encode("utf-8")).hexdigest()[:16]
    return entry


def updated_at(info):
    value = info.get("updatedAt")
    return value if isinstance(value, (int, float)) else 0


def live_sessions(folder):
    """登録ファイルから、プロセスが生きているセッションだけを選ぶ（同じ ID は最新の1件）。"""
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    chosen = {}
    for name in names:
        if not name.lower().endswith(".json"):
            continue  # .key などは開かない
        try:
            with open(os.path.join(folder, name), encoding="utf-8") as f:
                info = json.load(f)
            session_id = info.get("sessionId")
            if not isinstance(session_id, str) or not session_id or not alive(info.get("pid")):
                continue
        except Exception:
            continue  # 書きかけ・壊れた登録ファイルは飛ばす
        old = chosen.get(session_id)
        if old is None or updated_at(info) > updated_at(old):
            chosen[session_id] = info
    return list(chosen.values())


def project_folders(root):
    try:
        return [e.path for e in os.scandir(root) if e.is_dir()]
    except OSError:
        return []


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    base = os.path.join(os.path.expanduser("~"), ".claude")
    try:
        folders = project_folders(os.path.join(base, "projects"))
        infos = live_sessions(os.path.join(base, "sessions"))
        resolve = make_resolver(infos)
        sessions = [describe(info, folders, resolve) for info in infos]
        sessions.sort(key=lambda s: s["id"])
    except Exception:
        sessions = []  # 何があっても JSON は出す
    print(json.dumps({"sessions": sessions}, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
