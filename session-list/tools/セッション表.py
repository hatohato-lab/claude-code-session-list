"""セッション表: いま開いているセッションの名前・状態・圧縮回数・生ログの大きさを JSON で返す。

セッションリストMOD が10秒ごとに呼ぶ。読むだけで、何も書き換えない。
開いているかは、登録ファイル（~/.claude/sessions）があり、そのプロセスが生きているかで決める。
ただし自動タスク（起動の種類が sdk-cli）のセッションは、人が開いたタブではないので出さない。

標準入力に、前回の控え（生ログごとの、読み終えた位置・圧縮回数・名前）を JSON で受け取り、
増えた分だけを読む。控えが空なら生ログを頭から読む。
出力: {"rows": [{"id", "name", "status", "compactions", "bytes"}], "cache": {生ログの場所: 控え}}
"""
import ctypes
import glob
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
REGISTRY = os.path.join(HOME, ".claude", "sessions")
PROJECTS = os.path.join(HOME, ".claude", "projects")
STATUS = {"busy": "作業中", "idle": "待機中", "waiting": "確認待ち"}
AUTOMATED = {"sdk-cli"}
# 生ログの1行は JSON なので、文の中の引用符は \" になる。次の2つは行の項目そのものにだけ当たる
COMPACT = b'"subtype":"compact_boundary"'
TITLE = b'"type":"custom-title"'
ASSISTANT = b'"type":"assistant"'
# 最後の答えは、末尾のこの字数だけ控える（問いかけは答えの終わりにある）
ANSWER_TAIL = 1500
BOLD = re.compile(r"\*\*(.+?)\*\*")


ENVELOPE = re.compile(r"<cross-session-message ([^>]*)>" + r"\s*(.*?)\s*" + r"</cross-session-message>", re.S)
FROM_NAME = re.compile(r'from-name="([^"]*)"')
CROSS = b"cross-session-message"
# 届いた連絡は、新しいものからこの件数だけ控える
INBOX_MAX = 30


def stamp_ms(text):
    """生ログの時刻（ISO 形式）をミリ秒にする。読めなければ 0。"""
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError):
        return 0


def incoming(o):
    """生ログの1項目から、届いた連絡（送り主の宛先名、本文）を取り出す。"""
    texts = []
    if o.get("type") == "queue-operation" and o.get("operation") == "enqueue" and isinstance(o.get("content"), str):
        texts.append(o["content"])
    elif o.get("type") == "attachment" and (o.get("attachment") or {}).get("type") == "queued_command":
        # 作業中に届いて、順番待ちになった連絡
        prompt = o["attachment"].get("prompt")
        if isinstance(prompt, str):
            texts.append(prompt)
    elif o.get("type") == "user":
        content = (o.get("message") or {}).get("content")
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            texts += [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
    found = []
    for text in texts:
        if not text.lstrip().startswith("<cross-session-message"):
            continue
        for env in ENVELOPE.finditer(text):
            name = FROM_NAME.search(env.group(1))
            found.append((name.group(1) if name else "", env.group(2).strip()))
    return found


def summarize(text):
    """答えの要約。最初の太字の題名（お返事待ちを除く）、無ければ最初の行。"""
    for found in BOLD.finditer(text):
        title = found.group(1).strip()
        if title and not title.startswith("お返事待ち"):
            return title
    for line in text.splitlines():
        line = line.strip().lstrip("#>-*` ").strip()
        if line:
            return line
    return ""
CHUNK = 8 * 1024 * 1024


def alive(pid):
    """プロセスが生きているかを、問い合わせだけで確かめる（終了はさせない）。"""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
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


def log_path(session_id):
    """生ログの場所。同じ ID が複数のフォルダーにあるときは、いちばん新しく書かれたものを使う。"""
    found = glob.glob(os.path.join(glob.escape(PROJECTS), "*", glob.escape(session_id) + ".jsonl"))
    if not found:
        return None
    return max(found, key=os.path.getmtime)


def last_text(chunk):
    """読んだ範囲の中から、メインの会話の最後のアシスタントの文を返す（無ければ None）。"""
    for raw in reversed(chunk.split(b"\n")):
        if ASSISTANT not in raw:
            continue
        try:
            o = json.loads(raw)
        except ValueError:
            continue
        if o.get("type") != "assistant" or o.get("isSidechain"):
            continue
        content = (o.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        text = "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text").strip()
        if text:
            return text
    return None


def scan(path, size, memo):
    """生ログを、前回読み終えた位置から最後の改行まで読み、圧縮回数・名前・最後の答えを数え足す。"""
    offset = memo.get("offset", 0) if isinstance(memo.get("offset"), int) else 0
    compactions = memo.get("compactions", 0) if isinstance(memo.get("compactions"), int) else 0
    title = memo.get("title", "") if isinstance(memo.get("title"), str) else ""
    answer = memo.get("answer", "") if isinstance(memo.get("answer"), str) else ""
    summary = memo.get("summary", "") if isinstance(memo.get("summary"), str) else ""
    inbox = memo.get("inbox", []) if isinstance(memo.get("inbox"), list) else []
    if offset > size:
        # 生ログが置き換わったので、頭から読み直す
        offset, compactions, title, answer, summary, inbox = 0, 0, "", "", "", []
    with open(path, "rb") as fh:
        fh.seek(offset)
        rest = b""
        while True:
            block = fh.read(CHUNK)
            if not block:
                break
            data = rest + block
            cut = data.rfind(b"\n")
            if cut < 0:
                rest = data
                continue
            lines, rest = data[:cut + 1], data[cut + 1:]
            compactions += lines.count(COMPACT)
            if TITLE in lines:
                for line in lines.split(b"\n"):
                    if TITLE not in line:
                        continue
                    try:
                        title = json.loads(line).get("customTitle") or title
                    except ValueError:
                        pass
            if CROSS in lines:
                seen = {(one.get("from"), one.get("text"), one.get("at", 0) // 60000) for one in inbox if isinstance(one, dict)}
                for line in lines.split(b"\n"):
                    if CROSS not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    at = stamp_ms(o.get("timestamp", ""))
                    for sender, body in incoming(o):
                        key = (sender, body[:80], at // 60000)
                        if key in seen:
                            continue
                        seen.add(key)
                        inbox.append({"from": sender, "text": body[:80], "at": at})
                inbox = inbox[-INBOX_MAX:]
            if ASSISTANT in lines:
                text = last_text(lines)
                if text is not None:
                    answer = text[-ANSWER_TAIL:]
                    summary = summarize(text)[:400]
            offset += len(lines)
    return {"offset": offset, "compactions": compactions, "title": title, "answer": answer, "summary": summary, "inbox": inbox}


def registrations():
    """登録ファイルを読み、開いているセッションを ID ごとに1つ返す（同じ ID は新しく更新された方）。"""
    picked = {}
    for path in glob.glob(os.path.join(glob.escape(REGISTRY), "*.json")):
        try:
            with open(path, encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        sid = d.get("sessionId") if isinstance(d, dict) else None
        if not isinstance(sid, str) or not sid:
            continue
        if d.get("entrypoint") in AUTOMATED or not alive(d.get("pid", 0)):
            continue
        before = picked.get(sid)
        if before is None or (d.get("updatedAt") or 0) > (before.get("updatedAt") or 0):
            picked[sid] = d
    return picked


def last_answer(session_id):
    """生ログの末尾から、メインの会話の最後の答え（アシスタントの文）を返す。サブエージェントの答えは見ない。"""
    path = log_path(session_id)
    if not path:
        return ""
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        fh.seek(max(0, size - 4 * 1024 * 1024))
        data = fh.read()
    for raw in reversed(data.split(b"\n")):
        if b'"type":"assistant"' not in raw:
            continue
        try:
            o = json.loads(raw)
        except ValueError:
            continue
        if o.get("type") != "assistant" or o.get("isSidechain"):
            continue
        content = (o.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        text = "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text").strip()
        if text:
            return text
    return ""


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    # 「--last-answer セッションID」のときは、そのセッションの最後の答えだけを返す
    if len(sys.argv) >= 3 and sys.argv[1] == "--last-answer":
        json.dump({"answer": last_answer(sys.argv[2])}, sys.stdout, ensure_ascii=False)
        return
    try:
        cache = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        cache = {}
    if not isinstance(cache, dict):
        cache = {}
    rows, memos = [], {}
    for sid, d in registrations().items():
        path = log_path(sid)
        size = -1
        memo = {"offset": 0, "compactions": 0, "title": "", "answer": "", "summary": "", "inbox": []}
        if path:
            try:
                size = os.path.getsize(path)
                before = cache.get(path)
                memo = scan(path, size, before if isinstance(before, dict) else {})
                memos[path] = memo
            except OSError:
                size = -1
        user_name = d.get("name") if d.get("nameSource") == "user" and isinstance(d.get("name"), str) else ""
        status = d.get("status")
        rows.append({
            "id": sid,
            "name": user_name or memo["title"] or "（名前なし）",
            "status": STATUS.get(status, status if isinstance(status, str) and status else "不明"),
            "compactions": memo["compactions"],
            "bytes": size,
            "answer": memo.get("answer", ""),
            "summary": memo.get("summary", ""),
            "address": d.get("name") if isinstance(d.get("name"), str) else "",
            "inbox": memo.get("inbox", []),
            "entrypoint": d.get("entrypoint") if isinstance(d.get("entrypoint"), str) else "",
        })
    rows.sort(key=lambda r: r["name"])
    json.dump({"rows": rows, "cache": memos}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
