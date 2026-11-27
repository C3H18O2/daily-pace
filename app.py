#!/usr/bin/env python3
"""日拱一卒 — 本地 deadline 配速器。标准库单文件后端：静态文件 + JSON API + SQLite。"""

from __future__ import annotations

import atexit
import hashlib
import io
import json
import math
import os
import re
import shutil
import socket
import sqlite3
import sys
import threading
import time
import urllib.request
from urllib.parse import unquote, urlsplit
import zipfile
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).parent
DB = BASE / "data" / "pace.db"
PID_FILE = BASE / "data" / "pace.pid"  # 停止.bat 靠它拿到要杀的进程
STATIC = BASE / "static"
VERSION = "1.7.2"

# 默认更新源：发布者 GitHub Pages。settings 里的 update_url 可覆盖，供自部署
UPDATE_BASE = "https://c3h18o2.github.io/daily-pace/release"
# 默认跳转页：settings.pace_go_url 可覆盖；数据库设置不随 app.js 升级被覆盖
DEFAULT_GO_URL = "https://c3h18o2.github.io/daily-pace/go.html"
# 开发机保险：BASE 下有这个文件时禁止自动更新，防止开发中的自己被线上版本覆盖
DEV_NO_UPDATE_FILE = BASE / "DEV-NO-UPDATE"

# 同步热替换数据库的互斥锁：校验→备份→os.replace 必须原子，防止并发请求把库搞成半份
SYNC_LOCK = threading.Lock()


def cli_option(name: str) -> str | None:
    """预览启动器传入的 --host/--port；普通双击启动不带参数，行为不变。"""
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv \
        and sys.argv.index(name) + 1 < len(sys.argv) else None


CLI_PORT = cli_option("--port")
CLI_HOST = cli_option("--host")
PORT = int(CLI_PORT or os.environ.get("PACE_PORT", 18630))  # 避开本机动态端口段
BACKUP_KEEP = 7  # 保留最近几份备份，多出来的按时间从旧到新删
BUFFER = 0.9  # 有效天数缓冲系数：deadline 前留出一成余量
DEFAULT_ESTIMATE = 45
DEFAULT_DAY_START_HOUR = 7  # 默认早上 7 点算新的一天
PALETTE = ["#7a9b76", "#c08552", "#6e8fb2", "#b27a8f", "#8f86c9", "#c9a227", "#5fa8a0"]
# 项目删掉后 work_logs 会留下孤儿 project_id：显示时兜底，别让历史工时凭空消失
DELETED_PROJECT_NAME = "已删除项目"
DELETED_PROJECT_COLOR = "#999"


def proj_name(project_id, name) -> str:
    """work_logs/tasks 的 project_id 指向不存在的项目 = 项目已被删（工时记录保留）。"""
    if name:
        return name
    return "未分配" if project_id is None else DELETED_PROJECT_NAME


def proj_color(project_id, color) -> str:
    if color:
        return color
    return "#b8ad9a" if project_id is None else DELETED_PROJECT_COLOR


def trash_add(conn: sqlite3.Connection, kind: str, payload: dict):
    """软删除：把整行快照存进垃圾桶，之后可以按原 id 恢复。"""
    conn.execute("INSERT INTO trash(kind, payload, deleted_at) VALUES(?,?,?)",
                 (kind, json.dumps(payload, ensure_ascii=False),
                  datetime.now().isoformat(timespec="seconds")))


def trash_label(entry) -> tuple[str, int | None]:
    """垃圾桶条目的显示名；项目条目附带任务数（其他类型为 None）。"""
    try:
        payload = json.loads(entry["payload"])
    except Exception:
        return "（快照已损坏）", None
    if entry["kind"] == "project":
        p = payload.get("project") or {}
        return (p.get("name") or "（无名称项目）"), len(payload.get("tasks") or [])
    t = payload.get("task") or {}
    return (t.get("title") or "（无标题任务）"), None


def row_insert(conn: sqlite3.Connection, table: str, row: dict, allowed: set):
    """按快照里实际存在的列插回去，显式带上原 id（恢复出来的 id 和删之前一致）。"""
    cols = [c for c in row if c in allowed]
    if not cols:
        raise ValueError(f"{table} 快照里没有可用的列")
    conn.execute(
        f"INSERT INTO {table}({', '.join(cols)}) VALUES({', '.join('?' * len(cols))})",
        [row[c] for c in cols])


# 自动生成的「下一件」是否被用户动过：恢复完成时拿这份字段快照比一遍，不一样就留着别删
GEN_FIELDS = ("project_id", "title", "estimate_min", "routine", "workday_only", "due_date",
              "scheduled_date", "priority", "same_day", "lead_days", "repeat_type",
              "repeat_weekday", "repeat_monthday", "repeat_ordinal", "skip_holiday",
              "repeat_interval", "no_autosched", "tags", "detail")


def gen_link(conn: sqlite3.Connection, next_id: int, src_id: int):
    """记下这件下一件是「谁完成时」生成的 + 生成那一刻的字段快照（撤销完成时用）。"""
    row = conn.execute("SELECT * FROM tasks WHERE id=?", (next_id,)).fetchone()
    snap = {k: row[k] for k in GEN_FIELDS}
    conn.execute("UPDATE tasks SET gen_from=?, gen_snapshot=? WHERE id=?",
                 (src_id, json.dumps(snap, ensure_ascii=False, sort_keys=True), next_id))


def begin_write(conn: sqlite3.Connection):
    """进入 IMMEDIATE 写事务；调用方已经开着事务时直接复用，绝不中途 commit。"""
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")


def open_next_of(conn: sqlite3.Connection, task_id: int, max_nodes: int = 200):
    """顺着「谁完成时生成的」这条链往下找还没做完的那件。
    有就说明这个循环已经在跑，不该再长第二件（历史上撤销时保留过改动的下一件，
    再勾一次又会插一件一模一样的）。"""
    seen, frontier = set(), [task_id]
    while frontier and len(seen) < max_nodes:
        cur = frontier.pop(0)
        for kid in conn.execute("SELECT id, done FROM tasks WHERE gen_from=?", (cur,)).fetchall():
            if kid["id"] in seen:
                continue
            seen.add(kid["id"])
            if not kid["done"]:
                return kid["id"]
            frontier.append(kid["id"])
    return None


def undo_generated_next(conn: sqlite3.Connection, task_id: int):
    """撤销完成：把这次完成自动生成的那件下一件收回（删掉），返回 (已删, 保留)。
    保留的是用户后来动过的（改过字段/计过时/已完成）——那种情况不替用户做主。"""
    removed, kept = [], []
    for kid in conn.execute("SELECT * FROM tasks WHERE gen_from=?", (task_id,)).fetchall():
        if kid["done"] or conn.execute(
                "SELECT 1 FROM work_logs WHERE task_id=? LIMIT 1", (kid["id"],)).fetchone():
            kept.append(kid["id"])
            continue
        try:
            snap = json.loads(kid["gen_snapshot"] or "{}")
        except ValueError:
            snap = {}
        cur = {k: kid[k] for k in GEN_FIELDS}
        if not snap or any(cur.get(k) != v for k, v in snap.items()):
            kept.append(kid["id"])
            continue
        conn.execute("DELETE FROM tasks WHERE id=?", (kid["id"],))
        removed.append(kid["id"])
    return removed, kept


# 2026 年放假安排（国办发明电〔2025〕7号）：REST 为放假日，EXTRA_WORK 为调休补班日
REST_2026 = {
    "01-01", "01-02", "01-03",
    "02-15", "02-16", "02-17", "02-18", "02-19", "02-20", "02-21", "02-22", "02-23",
    "04-04", "04-05", "04-06",
    "05-01", "05-02", "05-03", "05-04", "05-05", "05-06", "05-07",
    "06-19", "06-20", "06-21",
    "09-25", "09-26", "09-27",
    "10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07",
}
EXTRA_WORK_2026 = {"01-04", "02-14", "02-28", "04-26", "04-27", "09-20", "10-10"}


def is_workday(d: date) -> bool:
    if d.year == 2026:
        md = d.strftime("%m-%d")
        if md in EXTRA_WORK_2026:
            return True
        if md in REST_2026:
            return False
    return d.weekday() < 5


def count_workdays(d1: date, d2: date) -> int:
    """[d1, d2) 区间里的工作日数：含 d1、不含 d2，所以 d2 <= d1 时为 0。
    半开区间是为了跟 deadline 的语义对齐——deadline 当天再动手就来不及了，
    算出来的正好是「今天到 deadline 之前还有几个工作日」。"""
    n = 0
    d = d1
    while d < d2:
        if is_workday(d):
            n += 1
        d += timedelta(days=1)
    return n


def fmt_min(m) -> str:
    m = int(round(m))
    h, mm = divmod(m, 60)
    if h and mm:
        return f"{h}h{mm:02d}m"
    return f"{h}h" if h else f"{mm}m"


def lan_ip() -> str | None:
    """本机局域网 IP：UDP 假连接只为拿到出口网卡地址，不真的发包。"""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def lan_url_text() -> str | None:
    """给页面直接点开的局域网地址；拿不到本机 IP（没联网/网卡没起）就给 None。"""
    ip = lan_ip()
    return f"http://{ip}:{PORT}" if ip else None


def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """端口上还有人在听吗：能连上就是还在。比 bind 试探准（bind 会被别人的
    SO_REUSEADDR 骗过去），也不用知道对方 pid。"""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.4)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def startup_vbs_path() -> Path:
    """Windows 登录启动文件夹里的隐藏启动脚本路径。"""
    return Path(os.environ.get("APPDATA", "")) / \
        "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "日拱一卒.vbs"


# 重启：辅助进程最多等多久（旧进程卡死时它自己放弃，不留一个永远在等的小进程）
RESTART_WAIT_GRACE = 90.0


def restart_args(old_pid: int) -> list:
    """辅助进程的命令行：同一个 app.py，带 --no-open（不重复弹浏览器）。"""
    return [sys.executable, str(Path(__file__).resolve()), "--no-open",
            "--restart-wait", str(old_pid)]


def spawn_restart_helper() -> int:
    """起一个独立辅助进程：等本进程让出端口，再用同样的参数把服务拉起来。

    必须另起进程：新服务要 bind 同一个端口，只要旧进程还占着就必然失败。顺序是
    「先回包 → 起辅助 → 旧 server shutdown → 辅助一直在等端口空 → 端口空了才 bind」。
    Windows 用 DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP：脱离当前控制台和进程组，
    旧进程退出时不会把它一起带走（否则重启永远停在「服务已停」）。
    """
    import subprocess
    flags = 0x00000008 | 0x00000200 if os.name == "nt" else 0
    p = subprocess.Popen(
        restart_args(os.getpid()), cwd=str(BASE), creationflags=flags, close_fds=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return p.pid


def wait_port_free(port: int, timeout: float = RESTART_WAIT_GRACE) -> bool:
    """等端口空出来。返回 False = 等到超时还占着（旧进程没退干净）。"""
    deadline = time.monotonic() + timeout
    while port_in_use(port):
        if time.monotonic() > deadline:
            return False
        time.sleep(0.2)
    return True



def set_autostart(on: bool):
    p = startup_vbs_path()
    if on:
        p.write_text(
            'Set sh = CreateObject("WScript.Shell")\n'
            f'sh.CurrentDirectory = "{BASE}"\n'
            'sh.Run "pythonw.exe app.py", 0, False\n',
            encoding="utf-8")
    else:
        p.unlink(missing_ok=True)


def remove_pid_file():
    """正常退出时删掉 pid 文件；里面的 pid 已经不是自己了就说明有更新的实例，别动它。"""
    try:
        if PID_FILE.read_text().strip() == str(os.getpid()):
            PID_FILE.unlink()
    except OSError:
        pass

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, color TEXT, deadline TEXT, created_at TEXT,
  workdays_only INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER, title TEXT, detail TEXT, estimate_min INTEGER DEFAULT 45,
  routine INTEGER DEFAULT 0, workday_only INTEGER DEFAULT 0, same_day INTEGER DEFAULT 0,
  lead_days INTEGER,
  done INTEGER DEFAULT 0,
  repeat_type TEXT, repeat_weekday INTEGER, repeat_monthday INTEGER,
  skip_holiday INTEGER DEFAULT 0, repeat_interval INTEGER,
  created_at TEXT, done_at TEXT);
CREATE TABLE IF NOT EXISTS work_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER, task_id INTEGER,
  start_at TEXT, end_at TEXT, minutes INTEGER, date TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS daily_safety_lines(
  date TEXT PRIMARY KEY, safety_min INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS daily_notes(date TEXT PRIMARY KEY, text TEXT);
CREATE TABLE IF NOT EXISTS dida_deleted(dida_id TEXT PRIMARY KEY, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS trash(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT, payload TEXT, deleted_at TEXT);
"""


def db() -> sqlite3.Connection:
    DB.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    for table, col, sql in [
        ("tasks", "due_date", "ALTER TABLE tasks ADD COLUMN due_date TEXT"),
        ("tasks", "scheduled_date", "ALTER TABLE tasks ADD COLUMN scheduled_date TEXT"),
        ("tasks", "workday_only", "ALTER TABLE tasks ADD COLUMN workday_only INTEGER DEFAULT 0"),
        ("tasks", "dida_id", "ALTER TABLE tasks ADD COLUMN dida_id TEXT"),
        ("tasks", "dida_list_id", "ALTER TABLE tasks ADD COLUMN dida_list_id TEXT"),
        ("tasks", "repeat_type", "ALTER TABLE tasks ADD COLUMN repeat_type TEXT"),
        ("tasks", "repeat_weekday", "ALTER TABLE tasks ADD COLUMN repeat_weekday INTEGER"),
        ("tasks", "repeat_monthday", "ALTER TABLE tasks ADD COLUMN repeat_monthday INTEGER"),
        ("tasks", "skip_holiday", "ALTER TABLE tasks ADD COLUMN skip_holiday INTEGER DEFAULT 0"),
        ("tasks", "repeat_ordinal", "ALTER TABLE tasks ADD COLUMN repeat_ordinal INTEGER"),
        ("tasks", "priority", "ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0"),
        ("tasks", "dida_repeat", "ALTER TABLE tasks ADD COLUMN dida_repeat INTEGER DEFAULT 0"),
        ("work_logs", "task_name", "ALTER TABLE work_logs ADD COLUMN task_name TEXT"),
        ("tasks", "no_autosched", "ALTER TABLE tasks ADD COLUMN no_autosched INTEGER DEFAULT 0"),
        ("projects", "dida_id", "ALTER TABLE projects ADD COLUMN dida_id TEXT"),
        ("projects", "no_track", "ALTER TABLE projects ADD COLUMN no_track INTEGER DEFAULT 0"),
        ("tasks", "same_day", "ALTER TABLE tasks ADD COLUMN same_day INTEGER DEFAULT 0"),
        ("projects", "workdays_only", "ALTER TABLE projects ADD COLUMN workdays_only INTEGER DEFAULT 0"),
        ("projects", "sort_order", "ALTER TABLE projects ADD COLUMN sort_order INTEGER DEFAULT 0"),
        ("tasks", "lead_days", "ALTER TABLE tasks ADD COLUMN lead_days INTEGER"),
        ("tasks", "gen_from", "ALTER TABLE tasks ADD COLUMN gen_from INTEGER"),
        ("tasks", "gen_snapshot", "ALTER TABLE tasks ADD COLUMN gen_snapshot TEXT"),
        ("tasks", "suspended", "ALTER TABLE tasks ADD COLUMN suspended INTEGER DEFAULT 0"),
        ("tasks", "suspended_at", "ALTER TABLE tasks ADD COLUMN suspended_at TEXT"),
        ("tasks", "tags", "ALTER TABLE tasks ADD COLUMN tags TEXT"),
        ("tasks", "detail", "ALTER TABLE tasks ADD COLUMN detail TEXT"),
        ("tasks", "repeat_interval", "ALTER TABLE tasks ADD COLUMN repeat_interval INTEGER"),
    ]:
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            conn.execute(sql)
    # 旧库迁移：新增的 sort_order 用原 id 回填，保证历史顺序不变；之后手动排序会写成 1,2,3...
    conn.execute("UPDATE projects SET sort_order = id WHERE COALESCE(sort_order, 0) = 0")
    # 不变量修复：workday_only=1 必然是日常（routine=1）。历史上有路径只写了
    # workday_only 没写 routine，导致完成后不生成下一件、日历也不投影。
    conn.execute("UPDATE tasks SET routine=1 WHERE workday_only=1 AND routine=0")
    # 一次性修复：滴答同步回填 due 时没动 scheduled_date，留下一批「排期停在旧 due」的任务。
    # 今日排期只认 scheduled_date == 今天，这些任务既不在今日也不在任务池，等于失踪。
    # 判据：排期日不晚于任务入库那天（本库不可能更早排期，只可能是入库时按当时的 due
    # 自动填的）且早于 due。用户手动挪过的排期都晚于入库日，不会被误伤。
    if not conn.execute(
            "SELECT 1 FROM settings WHERE key='migr_sched_follow_due'").fetchone():
        conn.execute(
            "UPDATE tasks SET scheduled_date=due_date "
            "WHERE done=0 AND due_date IS NOT NULL AND scheduled_date IS NOT NULL "
            "AND scheduled_date<>due_date AND scheduled_date<due_date "
            "AND scheduled_date<=substr(created_at,1,10) AND COALESCE(no_autosched,0)=0")
        conn.execute("INSERT INTO settings(key, value) VALUES('migr_sched_follow_due','1')")
    # v1.2.0 一次性迁移：滴答清单集成已移除，把还开放着的滴答重复任务转成普通日常任务，
    # 避免它们静默停止循环（workday_only 等标记保留，由现有 routine 逻辑接管）。
    # 同时清除本地保存的滴答令牌。
    if not conn.execute(
            "SELECT 1 FROM settings WHERE key='migr_dida_repeat_to_routine'").fetchone():
        conn.execute(
            "UPDATE tasks SET routine=1 "
            "WHERE COALESCE(dida_repeat,0)=1 AND routine=0 AND repeat_type IS NULL AND done=0")
        conn.execute("DELETE FROM settings WHERE key='dida_token'")
        conn.execute("INSERT INTO settings(key, value) VALUES('migr_dida_repeat_to_routine','1')")
    conn.commit()
    return conn


# ── 备份 ──────────────────────────────────────────────
# 用连接级 backup() 拿一致快照：服务在跑、库被写了一半时直接拷文件会得到坏库。
_backup_lock = threading.Lock()
_backup_day: str | None = None   # 进程内记住「今天备份过」，免得每个请求都去扫目录
_backup_error: str | None = None  # 上次失败原因，给设置页看


def backup_dir() -> Path:
    """备份就放在库旁边（data/backup/）：换库路径时备份根着走，测试用副本库也不会写进真实目录。"""
    return DB.parent / "backup"


BACKUP_IMPORTANT_KEEP = 3  # 同步/恢复前的回滚点单独保留，不被日常备份挤掉


def list_backups() -> list:
    """按修改时间正序列出备份；文件名可能带中文或版本号，绝不拿字典序当时间序。"""
    d = backup_dir()
    if not d.is_dir():
        return []
    return sorted(
        (p for p in d.iterdir() if p.name.startswith("pace-") and p.suffix == ".db"),
        key=lambda p: p.stat().st_mtime)


def is_important_backup(path: Path) -> bool:
    """important 是新版同步/恢复前备份；before 兼容此前手动留下的版本回滚点。"""
    return path.name.startswith(("pace-important-", "pace-before-"))


def prune_backups(protect: Path | None = None) -> list:
    """普通备份留 7 份，重要回滚点另留 3 份；protect 是正在恢复的原件，不能清掉。"""
    files = list_backups()
    groups = [
        ([p for p in files if not is_important_backup(p)], BACKUP_KEEP),
        ([p for p in files if is_important_backup(p)], BACKUP_IMPORTANT_KEEP),
    ]
    dropped = []
    for group, keep in groups:
        # 先跳过一次 protect，再从其余最旧文件里补足应删数量，保留总数仍不超额。
        candidates = [p for p in group if p != protect]
        for p in candidates[:max(0, len(group) - keep)]:
            try:
                p.unlink()
                dropped.append(p.name)
            except OSError as e:
                print(f"清理旧备份失败 {p.name}: {e}", file=sys.stderr)
    return dropped


def make_backup(reason: str = "", important: bool = False, protect: Path | None = None) -> Path:
    """在线快照当前库。important=True 时进入独立保留区，用于覆盖数据前的回滚点。"""
    global _backup_day, _backup_error
    with _backup_lock:
        d = backup_dir()
        d.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        prefix = "pace-important-" if important else "pace-"
        dst_path = d / f"{prefix}{stamp}.db"
        n = 1
        while dst_path.exists():  # 同一秒连点两次：加序号，不覆盖已有备份
            dst_path = d / f"{prefix}{stamp}-{n}.db"
            n += 1
        src = sqlite3.connect(DB)
        try:
            dst = sqlite3.connect(dst_path)
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
        prune_backups(protect=protect)
        _backup_day = datetime.now().date().isoformat()
        _backup_error = None
        print(f"已备份 → {dst_path.name}" + (f"（{reason}）" if reason else ""))
        return dst_path


def backup_ensure_daily():
    """每天第一次请求时补一份当天备份：跨夜不重启也不会漏。

    失败只记一笔，同一进程内不反复重试——否则每个请求都在一个坏路径上重试，
    页面会整体变慢。用户仍可在设置页点「立即备份」手动重试。
    """
    global _backup_day, _backup_error
    today = datetime.now().date().isoformat()
    if _backup_day == today:
        return
    try:
        if any(p.name.startswith(f"pace-{today.replace('-', '')}-") for p in list_backups()):
            _backup_day = today
            return
        make_backup("每日")
    except Exception as e:
        _backup_error = str(e)
        _backup_day = today
        print(f"每日备份失败：{e}", file=sys.stderr)


def backup_state() -> dict:
    """给前端看的备份概况（不读文件内容，只列目录）。"""
    files = list_backups()
    last = files[-1] if files else None
    return {
        "dir": str(backup_dir()),
        "last": last.name if last else None,
        "at": datetime.fromtimestamp(last.stat().st_mtime).isoformat(timespec="seconds")
        if last else None,
        "count": len(files),
        "keep": BACKUP_KEEP,
        "important_keep": BACKUP_IMPORTANT_KEEP,
        "important_count": sum(1 for p in files if is_important_backup(p)),
        "error": _backup_error,
    }


# ── 局域网同步辅助函数 ─────────────────────────────────────────

def sync_device_name(conn: sqlite3.Connection | None = None) -> str:
    """本机设备名：用户可改，缺省用 hostname。"""
    close = False
    if conn is None:
        conn = db()
        close = True
    try:
        r = conn.execute("SELECT value FROM settings WHERE key='sync_device'").fetchone()
        name = (r["value"] if r else "").strip()
        return name or socket.gethostname()
    finally:
        if close:
            conn.close()


def sync_peer_url(conn: sqlite3.Connection | None = None) -> str | None:
    """用户配的对端地址，去掉首尾空格；空字符串算没配。"""
    close = False
    if conn is None:
        conn = db()
        close = True
    try:
        r = conn.execute("SELECT value FROM settings WHERE key='sync_peer'").fetchone()
        url = (r["value"] if r else "").strip()
        return url or None
    finally:
        if close:
            conn.close()


def sync_info(conn: sqlite3.Connection | None = None) -> dict:
    """给 /api/sync/info 和本机对比用的统一信息字典。"""
    close = False
    if conn is None:
        conn = db()
        close = True
    try:
        counts = {
            "projects": conn.execute("SELECT COUNT(*) c FROM projects").fetchone()["c"],
            "tasks": conn.execute("SELECT COUNT(*) c FROM tasks").fetchone()["c"],
            "work_logs": conn.execute("SELECT COUNT(*) c FROM work_logs").fetchone()["c"],
        }
        mtime = int(DB.stat().st_mtime) if DB.exists() else 0
        return {
            "version": VERSION,
            "device": sync_device_name(conn),
            "db_mtime": mtime,
            "counts": counts,
        }
    finally:
        if close:
            conn.close()


def backup_file(name) -> Path:
    """把浏览器传来的文件名约束在备份目录内；只接受这里实际存在的 pace-*.db。"""
    if not isinstance(name, str) or not name or name in (".", ".."):
        raise ValueError("请选择要恢复的备份")
    if "/" in name or "\\" in name or ".." in name or Path(name).name != name:
        raise ValueError("备份文件名不合法")
    if not name.startswith("pace-") or not name.endswith(".db"):
        raise ValueError("只能恢复 pace-*.db 备份文件")
    path = backup_dir() / name
    if not path.is_file() or path.resolve().parent != backup_dir().resolve():
        raise ValueError("备份文件不存在")
    return path


def _validate_db_file(path: Path) -> str | None:
    """校验一份 SQLite 文件能不能当 pace 库用。返回 None=OK，否则是中文错误原因。"""
    try:
        test = sqlite3.connect(str(path))
        try:
            test.row_factory = sqlite3.Row
            checks = test.execute("PRAGMA quick_check").fetchall()
            if not checks or any(row[0] != "ok" for row in checks):
                detail = "；".join(str(row[0]) for row in checks[:3]) or "无检查结果"
                return f"数据库完整性检查未通过：{detail}"
            ok = test.execute(
                "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN (?, ?, ?)",
                ("projects", "tasks", "work_logs")).fetchone()["c"]
            if ok != 3:
                return "传入的数据库缺少必要的表（projects/tasks/work_logs）"
        finally:
            test.close()
    except sqlite3.DatabaseError as e:
        return f"数据库文件损坏或不是 SQLite：{e}"
    except Exception as e:
        return f"校验数据库失败：{e}"
    return None


def _replace_with_db(tmp: Path, reason: str = "同步覆盖前", protect: Path | None = None) -> str:
    """把已经校验过的 tmp 热替换为当前 DB，返回独立保留的回滚点名。全程在 SYNC_LOCK 内。"""
    import gc
    backup = make_backup(reason, important=True, protect=protect)
    # Windows 下刚关闭的连接可能还有瞬间句柄未释放，强制 GC 并阶梯重试
    for i in range(10):
        try:
            os.replace(tmp, DB)
            return backup.name
        except PermissionError:
            if i == 9:
                raise
            gc.collect()
            time.sleep(0.03 * (i + 1))
    return backup.name


def _snapshot_to_temp() -> Path:
    """用 sqlite backup API 把当前库快照到临时文件，返回路径。调用方负责删除。"""
    DB.parent.mkdir(parents=True, exist_ok=True)
    tmp = DB.parent / f"sync-snapshot-{int(time.time()*1000)}.tmp"
    src = sqlite3.connect(DB)
    try:
        dst = sqlite3.connect(tmp)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return tmp


def _http_request(peer: str, path: str, method: str = "GET", data: bytes | None = None,
                  timeout: float = 8.0, headers: dict | None = None) -> tuple[int, bytes]:
    """简单的同步 HTTP 客户端：返回 (status, body)。只用来访问对端 pace，不走代理。"""
    url = peer.rstrip("/") + path
    req = urllib.request.Request(url, method=method, data=data)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


# ── 自动更新辅助函数 ───────────────────────────────────────────

def is_dev_machine() -> bool:
    """开发机保险：BASE 下有 DEV-NO-UPDATE 文件时禁止自动更新。"""
    return DEV_NO_UPDATE_FILE.exists()


def update_enabled(conn: sqlite3.Connection | None = None) -> bool:
    """自动更新开关，默认关闭。"""
    close = False
    if conn is None:
        conn = db()
        close = True
    try:
        r = conn.execute("SELECT value FROM settings WHERE key='update_enabled'").fetchone()
        return bool(r and r["value"] == "1")
    finally:
        if close:
            conn.close()


def update_url(conn: sqlite3.Connection | None = None) -> str:
    """更新源基地址，可覆盖默认 GitHub Pages。"""
    close = False
    if conn is None:
        conn = db()
        close = True
    try:
        r = conn.execute("SELECT value FROM settings WHERE key='update_url'").fetchone()
        url = (r["value"] if r else "").strip()
        return url or UPDATE_BASE
    finally:
        if close:
            conn.close()


def pace_go_url(conn: sqlite3.Connection | None = None) -> str:
    """手机访问跳转页，空设置表示使用发布者提供的默认地址。"""
    close = False
    if conn is None:
        conn = db()
        close = True
    try:
        r = conn.execute("SELECT value FROM settings WHERE key='pace_go_url'").fetchone()
        url = (r["value"] if r else "").strip()
        return url or DEFAULT_GO_URL
    finally:
        if close:
            conn.close()


def _fetch_manifest(base: str, timeout: float = 10.0) -> dict:
    """从更新源拉 manifest.json。失败抛中文异常。"""
    url = base.rstrip("/") + "/manifest.json"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            if resp.status != 200:
                raise ValueError(f"HTTP {resp.status}")
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise ValueError("还没有可用的更新源")
        raise ValueError(f"更新源连不上：HTTP {e.code}")
    except urllib.error.URLError as e:
        raise ValueError(f"更新源连不上：{e.reason}")
    except json.JSONDecodeError as e:
        raise ValueError(f"更新源清单格式不对：{e}")


def _sha256_file(path: Path) -> str:
    """计算文件 sha256（小文件一次性读，这些文件都不大）。"""
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _is_update_path_allowed(rel: str) -> bool:
    """更新包里的相对路径白名单：拒绝 ..、绝对路径、反斜杠开头。"""
    if not rel or rel.startswith("/") or rel.startswith("\\") or ".." in rel.split("/"):
        return False
    parts = Path(rel).parts
    if not parts:
        return False
    first = parts[0]
    # 允许：app.py、static/下任意、*.bat、*.txt
    if first == "app.py":
        return True
    if first == "static":
        return True
    if first.endswith(".bat") or first.endswith(".txt"):
        return True
    return False


def _release_files() -> list[Path]:
    """本机可作为更新源发布的文件列表，规则与 daily-pace make_release.py 一致。"""
    files: set[Path] = set()
    patterns = ["app.py", "static/**/*", "*.bat", "使用说明.txt", "更新日志.txt"]
    for pattern in patterns:
        if pattern.endswith("/**/*"):
            root = BASE / pattern[:-4]
            if root.is_dir():
                for p in root.rglob("*"):
                    if p.is_file():
                        files.add(p.relative_to(BASE))
        else:
            for p in BASE.glob(pattern):
                if p.is_file():
                    files.add(p.relative_to(BASE))
    return sorted(files, key=lambda p: str(p).replace("\\", "/"))


def _release_manifest() -> dict:
    """生成 /release/manifest.json 内容。"""
    return {
        "version": VERSION,
        "generated_at": datetime.now().isoformat(),
        "files": {str(rel).replace("\\", "/"): _sha256_file(BASE / rel)
                  for rel in _release_files()},
    }


def _compile_app_py(code: bytes) -> str | None:
    """校验一份 app.py 能不能 compile。返回 None=OK，否则中文错误。"""
    try:
        compile(code, "<app.py>", "exec")
    except SyntaxError as e:
        return f"app.py 语法错误：{e}"
    except Exception as e:
        return f"app.py 编译失败：{e}"
    return None


def _check_app_version(code: bytes, expected: str) -> str | None:
    """确认 app.py 里写了 VERSION = "expected"。返回 None=OK。"""
    try:
        text = code.decode("utf-8")
    except UnicodeDecodeError as e:
        return f"app.py 不是 UTF-8：{e}"
    m = re.search(r'^VERSION\s*=\s*["\']([^"\']+)["\']', text, re.MULTILINE)
    if not m:
        return "app.py 里找不到 VERSION 常量"
    if m.group(1) != expected:
        return f"app.py 版本号不符：期望 {expected}，实际 {m.group(1)}"
    return None


def _replace_file_atomic(src: Path, dst: Path):
    """把 src 原子替换到 dst。Windows 下 dst 被占用时重试几次。"""
    for i in range(10):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == 9:
                raise
            time.sleep(0.03 * (i + 1))


def lan_access_enabled(conn) -> bool:
    """局域网访问开关：默认开（手机连同一 Wi-Fi 就能用是现有用法）。"""
    r = conn.execute("SELECT value FROM settings WHERE key='lan_access'").fetchone()
    return not r or r["value"] != "0"


# 这一进程真实绑在哪：main() 绑端口时写进来。None = 还没绑（被人 import 当库用、
# 或者跑 py_compile 那种场景），这时候读 state 就按配置算，别让调用方拿到 None。
_LAN_RUNTIME: bool | None = None


def set_lan_runtime(on: bool):
    global _LAN_RUNTIME
    _LAN_RUNTIME = bool(on)


def lan_runtime(config_on: bool) -> bool:
    """实际绑定是否 LAN。配置和运行态是两件事：开关只改配置，
    只有重启（重新 bind）之后运行态才会跟上——这正是「关了开关手机还能连」的根源。"""
    return config_on if _LAN_RUNTIME is None else _LAN_RUNTIME


RECOMMEND_MIN_DEFAULT = 30


def recommend_min_minutes(conn) -> int:
    """小额建议阈值：share 低于它、且不是「本来就小」也不是「快到期」的，归到小额。
    0 = 不分档（全部留在主建议里）；非法值（没写/非数字/越界）一律回落 30。"""
    r = conn.execute("SELECT value FROM settings WHERE key='recommend_min_minutes'").fetchone()
    try:
        v = int(r["value"]) if r else RECOMMEND_MIN_DEFAULT
    except (TypeError, ValueError):
        v = RECOMMEND_MIN_DEFAULT
    return v if 0 <= v <= 480 else RECOMMEND_MIN_DEFAULT


def recommend_project_ids(conn) -> list:
    """优先项目（用户排定的顺序，越靠前越优先）。

    存量只认库里还在的项目：删掉的项目自动从顺序里掉出去，不用每次读都清理。
    脏数据（不是 JSON、不是数组、混了非数字）逐项跳过，不整条作废。
    """
    r = conn.execute("SELECT value FROM settings WHERE key='recommend_project_ids'").fetchone()
    raw = []
    if r and r["value"]:
        try:
            raw = json.loads(r["value"])
        except (TypeError, ValueError):
            raw = []
    if not isinstance(raw, list):
        return []
    alive = {row["id"] for row in conn.execute("SELECT id FROM projects")}
    out = []
    for v in raw:
        try:
            n = int(v)
        except (TypeError, ValueError):
            continue
        if n in alive and n not in out:
            out.append(n)
    return out


def day_start_hour(conn) -> int:
    """每天从几点开始算新的一天（字符串存 int）；非法值一律回落到默认值。"""
    r = conn.execute("SELECT value FROM settings WHERE key='day_start_hour'").fetchone()
    try:
        h = int(r["value"]) if r else DEFAULT_DAY_START_HOUR
    except (TypeError, ValueError):
        h = DEFAULT_DAY_START_HOUR
    return h if 0 <= h <= 23 else DEFAULT_DAY_START_HOUR


def logical_date(ts: str | None, h: int) -> date | None:
    """真实时间戳属于哪个逻辑日：减去起始点小时后取日期（凌晨 2 点设 7 点即算前一天）。"""
    if not ts:
        return None
    try:
        return (datetime.fromisoformat(ts) - timedelta(hours=h)).date()
    except ValueError:
        return None


def logical_today(conn) -> date:
    return (datetime.now() - timedelta(hours=day_start_hour(conn))).date()


def real_today() -> date:
    """真实日期（0 点翻页）：排期、今日列表、安全线、日历投影都按这个走。"""
    return datetime.now().date()


def logical_day_bounds(d: date, h: int) -> tuple[str, str]:
    """逻辑日 d 覆盖的真实时间窗 [d+h, d+1+h)，用字符串比较即可（格式和写入一致）。"""
    start = datetime(d.year, d.month, d.day, h)
    return (start.isoformat(timespec="seconds"),
            (start + timedelta(days=1)).isoformat(timespec="seconds"))


def count_challenge_streak(today: date, is_met) -> int:
    """今天未达标时保留截至昨天的连续成绩；没有历史安全线的日子不算达标。"""
    d = today
    if not is_met(d):
        d -= timedelta(days=1)
    streak = 0
    while is_met(d):
        streak += 1
        d -= timedelta(days=1)
    return streak


def count_safety_streak(today: date, lines: dict, invested: dict) -> int:
    """安全线为 0 的日子跳过：不增加天数，也不中断前后正需求日的连续成绩。"""
    d = today
    while lines.get(d.isoformat()) == 0:
        d -= timedelta(days=1)
    line = lines.get(d.isoformat())
    if line is None:
        return 0
    if invested.get(d.isoformat(), 0) < line:
        d -= timedelta(days=1)
    streak = 0
    while True:
        line = lines.get(d.isoformat())
        if line is None:
            break
        if line == 0:
            d -= timedelta(days=1)
            continue
        if invested.get(d.isoformat(), 0) < line:
            break
        streak += 1
        d -= timedelta(days=1)
    return streak


# loop = 每天/每个周期都要再来一次的任务：日常（routine）、周期重复（repeat_type）。
# SQL 里统一用 loop_sql() 拼，带上各自的表别名
def loop_sql(pre: str = "t.") -> str:
    return f"({pre}routine=1 OR {pre}repeat_type IS NOT NULL)"


def is_loop(t) -> bool:
    return bool(t["routine"] or t["repeat_type"])


def est_min(t) -> int:
    """预估分钟；NULL = 暂无预估，配速/安全线/建议里一律按 0 算（等于不占量）。"""
    return t["estimate_min"] or 0


def is_today_routine(t, today: date, h: int) -> bool:
    """这个任务是不是今天这一件日常实例（open/done 都算）。
    完成态实例的排期可能被滴答同步推走，用完成时间兜底认亲。"""
    if t["scheduled_date"] == today.isoformat():
        return True
    if t["done"] and logical_date(t["done_at"], h) == today:
        return True
    return t["scheduled_date"] is None and (
        not t["workday_only"] or is_workday(today))


def _valid_date(s) -> str | None:
    s = (s or "").strip()
    if s:
        date.fromisoformat(s)
        return s
    return None


def effective_days(days: int) -> int:
    return max(1, math.ceil(days * BUFFER))


def _norm_estimate(v) -> int | None:
    """归一化预估分钟：空值 = 暂无预估（存 NULL）；数字必须大于 0。"""
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    est = int(v)
    if est <= 0:
        raise ValueError("预估时长必须大于 0")
    return est


def _norm_tags(v) -> str | None:
    """归一化标签：逗号/空格/顿号分隔，去空白、去重，按首次出现顺序存逗号串。

    空值/空串 = 没有标签（存 NULL）。标签只是分类用的记号，不做长度校验，
    但把空白和重复清掉，避免「qc」「QC」「 qc 」在统计里裂成三份。去重比的是
    小写，存的却是第一次写的那个写法——显示要原样（「QC」就该看到 QC）。
    """
    if v is None:
        return None
    items = v if isinstance(v, list) else [v]
    out = []
    seen = set()
    for it in items:
        for part in str(it).replace("，", ",").replace("、", ",").split():
            for tg in part.split(","):
                tg = tg.strip()
                if tg and tg.lower() not in seen:
                    seen.add(tg.lower())
                    out.append(tg)
    return ",".join(out) or None


DETAIL_MAX = 4000   # 详情就是给人写「背景/要求/链接/下一步」的，不让它无限长


def _norm_detail(v) -> str | None:
    """归一化任务详情：多行文本原样保留（换行是有意义的排版），
    只统一换行符、砍掉首尾空白。空 = 没有详情（存 NULL）。

    和 work_logs.note 的区别：note 是「这一次干了什么」的流水，detail 是
    「这件事本身」的长期说明（背景、要求、链接、下一步），跟着任务走、复制/循环都继承。
    """
    if v is None:
        return None
    s = str(v).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not s:
        return None
    return s[:DETAIL_MAX]


def tag_list(raw: str | None) -> list:
    """把 tags 列的逗号串拆成列表（读取侧用，容忍历史脏数据）。

    保留原样大小写；要比大小写的地方自己 .lower()（统计按小写归组）。
    """
    if not raw:
        return []
    return [x.strip() for x in str(raw).split(",") if x.strip()]


def _norm_day_list(v, lo: int, hi: int) -> str | None:
    """接受单个数字或数组，归一化成逗号分隔字符串（存在 INTEGER 列里，SQLite 不挑类型）；空则 None。"""
    if v is None or v == "":
        return None
    items = v if isinstance(v, list) else [v]
    out = sorted({int(x) for x in items if str(x).strip() != ""})
    if not out:
        return None
    if any(x < lo or x > hi for x in out):
        raise ValueError("重复的日期设置无效")
    return ",".join(str(x) for x in out)


def _day_list(v) -> list:
    if v is None:
        return []
    return [int(x) for x in str(v).split(",") if x.strip()]


def _norm_lead(v) -> int | None:
    """归一化提前天数：空 = 不限（None）；0 = 仅当天可做；负数非法。"""
    if v is None or v == "":
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise ValueError("提前天数必须是整数")
    if n < 0:
        raise ValueError("提前天数不能是负数")
    return n


def task_lead(t) -> int | None:
    """任务从 due 前几天开始进安全线/今日建议。same_day 就是 lead_days=0 的老写法；
    None = 不限（提前多久都摊）；负数当不限，免得脏数据把任务永久藏起来。"""
    if t["same_day"]:
        return 0
    v = t["lead_days"]
    if v is None:
        return None
    v = int(v)
    return v if v >= 0 else None


def lead_active(t, today: date) -> bool:
    """今天是否已进入这个任务的窗口（窗口 = [due - 提前天数, due]）。"""
    if not t["due_date"]:
        return False
    lead = task_lead(t)
    if lead is None:
        return True
    return (date.fromisoformat(t["due_date"]) - today).days <= lead


def next_repeat_date(t, today: date) -> str | None:
    """到期重复：从完成日（今天）往后算下一个实例日期。"""
    from calendar import monthrange
    rt = t["repeat_type"]
    if rt == "daily":
        d = today + timedelta(days=1)
    elif rt == "weekly":
        wds = _day_list(t["repeat_weekday"]) or [today.weekday()]
        d = today + timedelta(days=1)
        while d.weekday() not in wds:
            d += timedelta(days=1)
    elif rt == "interval_weekly":
        # 每 N 周的周几：逐日往后扫，最多扫 N+1 周必然命中
        limit = 7 * max(int(t["repeat_interval"] or 1), 1) + 7
        d = today + timedelta(days=1)
        for _ in range(limit):
            if interval_weekly_on(t, d):
                break
            d += timedelta(days=1)
        else:
            return None
    elif rt == "monthly_workday":
        n = t["repeat_ordinal"] or 1
        d = None
        for i in range(13):
            y = today.year + (today.month - 1 + i) // 12
            m = (today.month - 1 + i) % 12 + 1
            c = _nth_workday(y, m, n)
            if c and c > today:
                d = c
                break
        if d is None:
            return None
    elif rt == "monthly":
        mds = _day_list(t["repeat_monthday"]) or [today.day]
        cands = []
        for i in (0, 1):  # 本月还没到的不等下个月，直接落本月
            y = today.year + (today.month + i - 1) // 12
            m = (today.month + i - 1) % 12 + 1
            last = monthrange(y, m)[1]
            for md in mds:
                c = date(y, m, min(md, last))
                if c > today:
                    cands.append(c)
        d = min(cands)
    elif rt == "monthly_week":
        # 每月第 N 个周几；ordinal -1 表示最后一个
        wd = (_day_list(t["repeat_weekday"]) or [today.weekday()])[0]
        n = t["repeat_ordinal"] or 1
        for i in (0, 1):
            y = today.year + (today.month + i - 1) // 12
            m = (today.month + i - 1) % 12 + 1
            if n == -1:
                last = date(y, m, monthrange(y, m)[1])
                c = last - timedelta(days=(last.weekday() - wd) % 7)
            else:
                first = date(y, m, 1)
                c = first + timedelta(days=(wd - first.weekday()) % 7, weeks=n - 1)
                if c.month != m:
                    continue
            if c > today:
                d = c
                break
    else:
        return None
    if t["skip_holiday"]:
        while not is_workday(d):
            d += timedelta(days=1)
    return d.isoformat()


def project_task_dates(t, start: date, end: date, today: date) -> list[str]:
    """日历投影：日常/重复规则在 [start, end] 内会执行的日子。
    已排期的当前实例在正常格子里显示，投影只从它之后开始，避免重影；
    且不从 today 之前开始（过去的日子不补虚影）。"""
    out = []
    if t["routine"]:
        anchor = date.fromisoformat(t["scheduled_date"] or t["due_date"]) \
            if (t["scheduled_date"] or t["due_date"]) else start - timedelta(days=1)
        d = max(start, anchor + timedelta(days=1), today)
        while d <= end:
            if not t["workday_only"] or is_workday(d):
                out.append(d.isoformat())
            d += timedelta(days=1)
    elif t["repeat_type"]:
        lead = task_lead(t)
        base = t["scheduled_date"] or t["due_date"]
        # 当前这一期的提前窗口也要铺虚影：真实条目只在 scheduled_date 那天，不补的话
        # 提前量内的日子日历上完全看不到它（安全线和今日建议其实已经算进它了）。
        # 只铺到 base 前一天，base 当天是真实条目，不重复画
        if lead and base:
            bd = date.fromisoformat(base)
            d = max(start, bd - timedelta(days=lead), today)
            while d < bd:
                out.append(d.isoformat())
                d += timedelta(days=1)
        cur = date.fromisoformat(base) if base else start - timedelta(days=1)
        for _ in range(40):  # 保险：规则异常时不死循环
            nd = next_repeat_date(t, cur)
            if not nd or nd > end.isoformat():
                break
            cur = date.fromisoformat(nd)
            if cur >= start and cur >= today:
                if lead is None:
                    out.append(nd)
                else:
                    # 有提前量：这一期的虚影从窗口起点铺到发生日（lead=0 就是只有当天），
                    # 早于 today 的格子照旧不补
                    d = max(start, cur - timedelta(days=lead), today)
                    while d <= cur:
                        out.append(d.isoformat())
                        d += timedelta(days=1)
    return sorted(set(out))


def _anchor_date(t) -> date | None:
    base = t["scheduled_date"] or t["due_date"]
    try:
        return date.fromisoformat(base) if base else None
    except ValueError:
        return None


def _week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _repeat_anchor(t) -> date | None:
    """每 N 周的相位锚点：优先排期/due 所在周，都没有就退到创建日期那一周。"""
    a = _anchor_date(t)
    if a:
        return a
    try:
        return date.fromisoformat((t["created_at"] or "")[:10])
    except ValueError:
        return None


def interval_weekly_on(t, d: date) -> bool:
    """每 N 周的周几：d 落在锚点周起每 N 周的目标星期上。锚点之前的日子不算。"""
    wds = _day_list(t["repeat_weekday"])
    anchor = _repeat_anchor(t)
    if not wds or anchor is None or d < anchor or d.weekday() not in wds:
        return False
    n = int(t["repeat_interval"] or 1)
    if n <= 1:
        return True
    return ((_week_start(d) - _week_start(anchor)).days // 7) % n == 0


def _nth_workday(y: int, m: int, n: int) -> date | None:
    """当月第 n 个工作日（n=-1 为最后一个）；n 超过当月工作日数时返回 None。"""
    from calendar import monthrange
    last = monthrange(y, m)[1]
    if n == -1:
        d = date(y, m, last)
        while not is_workday(d):
            d -= timedelta(days=1)
        return d
    cnt = 0
    for day in range(1, last + 1):
        d = date(y, m, day)
        if is_workday(d):
            cnt += 1
            if cnt == n:
                return d
    return None


def repeat_on_rule(t, d: date) -> bool:
    """d 这天是不是这个重复任务的规则日（先不管节假日顺延）。"""
    from calendar import monthrange
    rt = t["repeat_type"]
    if rt == "daily":
        return True
    anchor = _anchor_date(t)
    if rt == "weekly":
        wds = _day_list(t["repeat_weekday"]) or ([anchor.weekday()] if anchor else [])
        return d.weekday() in wds
    if rt == "interval_weekly":
        return interval_weekly_on(t, d)
    if rt == "monthly_workday":
        n = t["repeat_ordinal"] or 1
        return is_workday(d) and _nth_workday(d.year, d.month, n) == d
    if rt == "monthly":
        last = monthrange(d.year, d.month)[1]
        mds = _day_list(t["repeat_monthday"]) or ([anchor.day] if anchor else [])
        return any(min(md, last) == d.day for md in mds)
    if rt == "monthly_week":
        wds = _day_list(t["repeat_weekday"]) or ([anchor.weekday()] if anchor else [])
        if d.weekday() != wds[0]:
            return False
        n = t["repeat_ordinal"] or 1
        if n == -1:  # 最后一个周几
            return d.day + 7 > monthrange(d.year, d.month)[1]
        return (d.day - 1) // 7 + 1 == n
    return False


def _next_workday(d: date) -> date:
    for _ in range(15):
        if is_workday(d):
            return d
        d += timedelta(days=1)
    return d


def repeat_happens(t, today: date) -> bool:
    """这个重复任务今天是否轮到一期。skip_holiday 的规则日会顺延到之后第一个工作日，
    所以除了看今天，还要往回找被顺延到今天的规则日（春节最长 9 天假，回看 10 天够了）。
    手动排期优先于规则日：当前实例被挪到未来 → 规则日不触发（挪到的那天会作为
    普通排期条目出现）；实例排期就在今天 → 不管规则直接轮到（挪到非规则日也算数）。"""
    anchor = _anchor_date(t)
    if anchor:
        if anchor > today:
            return False
        if anchor == today:
            return True
    for k in range(11 if t["skip_holiday"] else 1):
        d = today - timedelta(days=k)
        if repeat_on_rule(t, d) and (not t["skip_holiday"] or _next_workday(d) == today):
            return True
    return False


def repeat_window_open(t, today: date) -> bool:
    """当前这期的提前窗口是否已开（窗口 = [due - 提前天数, due)，due 当天走规则日判定）。
    窗口内这期实例就算「轮到」：今日页提前亮出（不做也不催，due 没变），安全线按
    剩余预估 ÷ 剩余天数摊量，不背全额。
    留空（不限）对重复任务按不提前处理——天天亮出来太吵；逾期的不在这里兜，保持原口径。"""
    if t["done"] or not t["due_date"] or t["due_date"] <= today.isoformat():
        return False
    lead = task_lead(t)
    return bool(lead) and lead_active(t, today)


def loop_today_min(tasks, today: date, h: int) -> int:
    """今天这一期 loop 实例的预估合计。同一件任务（项目+标题）只算一期：今天的实例
    已经勾掉就只算它，别再把自动长出来的下一件按规则也算一遍——重复任务的下一件
    往往也落在同一个规则日上（周一的事勾完，下一件还是周一）。"""
    done_today = {(t["project_id"], t["title"]) for t in tasks
                  if t["done"] and logical_date(t["done_at"], h) == today}
    total, seen = 0, set()
    for t in tasks:
        if not is_loop(t):
            continue
        key = (t["project_id"], t["title"])
        if key in seen:
            continue
        if t["done"]:
            happens = logical_date(t["done_at"], h) == today
        elif t["routine"]:
            happens = is_today_routine(t, today, h)
        elif t["repeat_type"]:
            happens = key not in done_today and (
                repeat_happens(t, today) or repeat_window_open(t, today))
        if not happens:
            continue
        seen.add(key)
        m = est_min(t)
        # 纯预估口径下的窗口摊量（无工时数据可用，按全额预估 ÷ 剩余天数）：
        # 与 settle_loop_today 的动态结算同向，只是不扣已做部分
        if (not t["done"] and t["repeat_type"] and not t["routine"] and m
                and t["due_date"] and t["due_date"] > today.isoformat()
                and not repeat_happens(t, today) and repeat_window_open(t, today)):
            days_left = (date.fromisoformat(t["due_date"]) - today).days + 1
            m = math.ceil(m / max(1, days_left) / 5) * 5
        total += m
    return total


def settle_loop_today(conn, today: date, h: int, no_track_ids: set):
    """今天这一期 loop 实例的结算明细（v0.19.0 动态结算）。

    去重键和 loop_today_min 一致：(项目, 标题)。同一件任务今天只算一期，已勾掉的那件
    优先占住键（先排 done，再排 open），自动长出来的下一件不再跟着对冲。

    结算规则（勾掉的按实际工时降安全线）：
      · 勾掉 + 有计时 → min(实际, 预估)：干得快线就降，超预估不扩（差额进 over_est）
      · 勾掉 + 没计时 → 按预估（没计时 ≠ 做得快，不能当成 0）
      · 没勾 → 按预估；周期重复按「剩余预估」（本期已做的不重复催），其中只靠
        提前窗口亮出的实例再按含今天的剩余天数均摊（item 带 window/suggest_min）
      · 无预估（estimate_min NULL）一律算 0：分钟上不占量，靠 remaining_count 拦住
        误判清空，实际工时进 noest_actual 角标

    返回 (pending, done)，每项带 task_id/gen_from/project_id/title/est/actual/
    has_actual/settled/over_est/tracked（tracked = 这件算不算进安全线合计）。
    """
    lo, hi = logical_day_bounds(today, h)
    act_min = {r["task_id"]: r["m"] for r in conn.execute(
        "SELECT task_id, SUM(minutes) m FROM work_logs "
        "WHERE date=? AND task_id IS NOT NULL GROUP BY task_id", (today.isoformat(),))}
    # 本实例累计工时（自动长出的下一件是新行，日志都挂在本实例 id 上，全量即本期的量）：
    # 用于算「剩余预估」——窗口摊量和规则日结算都按剩下的来，已做的不重复催
    act_tot = {r["task_id"]: r["m"] for r in conn.execute(
        "SELECT task_id, SUM(minutes) m FROM work_logs "
        "WHERE task_id IS NOT NULL GROUP BY task_id")}
    done_today_keys = {(r["project_id"], r["title"]) for r in conn.execute(
        "SELECT project_id, title, done_at FROM tasks WHERE done=1 AND done_at>=? AND done_at<?",
        (lo, hi)) if logical_date(r["done_at"], h) == today}
    pending, done, seen = [], [], set()
    for t in conn.execute(
            f"SELECT * FROM tasks t WHERE {loop_sql()} ORDER BY done DESC, id"):
        key = (t["project_id"], t["title"])
        if t["done"]:
            happens = logical_date(t["done_at"], h) == today
        elif t["routine"]:
            happens = is_today_routine(t, today, h)
        elif t["repeat_type"]:
            happens = key not in done_today_keys and (
                repeat_happens(t, today) or repeat_window_open(t, today))
        if not happens or key in seen:
            continue
        # 非工作日的「仅工作日」日常不算剩余（前端今日排期同样收起这些，口径对齐）
        if not t["done"] and t["workday_only"] and not is_workday(today):
            continue
        seen.add(key)
        est = t["estimate_min"]
        actual = act_min.get(t["id"], 0) or 0
        has_actual = actual > 0
        over_est = 0
        # 周期重复（非日常）按「剩余预估」结算：本期已做的工时不重复催
        # （没做过 = 剩全额，与「没勾按预估」口径一致）。提前窗口里只亮出来还没到
        # 规则日/挪定日的实例，再按含今天的剩余天数均摊——90m 提前 5 天，
        # 不会每天都背一整份 90m。
        remaining = None
        window_only = False
        if not t["done"] and t["repeat_type"] and not t["routine"] and est is not None:
            remaining = max(est - (act_tot.get(t["id"], 0) or 0), 0)
            window_only = not repeat_happens(t, today) and repeat_window_open(t, today)
        if t["done"] and has_actual and est is not None:
            settled = min(actual, est)
            over_est = max(0, actual - est)
        elif remaining is not None and window_only:
            days_left = (date.fromisoformat(t["due_date"]) - today).days + 1
            settled = math.ceil(remaining / max(1, days_left) / 5) * 5
        elif remaining is not None:
            settled = remaining
        else:
            settled = est or 0
        item = {
            "task_id": t["id"], "gen_from": t["gen_from"], "project_id": t["project_id"],
            "title": t["title"], "est": est, "actual": actual,
            "has_actual": has_actual, "settled": settled, "over_est": over_est,
            "done": bool(t["done"]),
            "tracked": t["project_id"] is not None and t["project_id"] not in no_track_ids,
        }
        if window_only:
            item["window"] = True
            item["suggest_min"] = settled
            item["remaining_min"] = remaining
        if t["done"]:
            item["done_at"] = t["done_at"]
            done.append(item)
        else:
            pending.append(item)
    return pending, done


CALIB_WINDOW = 7      # 每个 loop 任务最多看最近几个样本
CALIB_MIN_N = 3       # 少于此数不出建议（样本太少，均值不可信）
CALIB_MIN_EST = 20    # est 小于此值的任务不出建议：15 分钟的事差 5 分钟就是 33%，催起来没意义
CALIB_WARN_RATIO = 0.5  # 均值与 est 偏差超过这个比例时附一句提醒（不拦着改，只提醒先看看记录）


def _round5(x: float) -> int:
    """四舍五入到 5 的倍数：45/50 这类整数分钟的预估，改起来也整。"""
    return int(round(x / 5.0)) * 5


def loop_calib(conn, today: date, h: int) -> list:
    """loop 任务「预估 vs 实际」校准建议（v0.19.6，只读，不改任何东西）。

    样本 = 已完成的 loop 实例 + 当天该 task_id 有计时（actual>0）。没计时直接勾掉的
    不进样本——「没计时」不等于「做得快」，跟动态结算的 has_actual 同口径。
    按 (project_id, title) 归并，和结算的去重键一致；改名会断键，已知口径。

    建议规则（v0.20.0 起一次到位）：样本 <3 不提；est < 20 不提；建议值 = 均值四舍五入
    到 5 的倍数（无预估就直接用均值），不再按 ±30% 钳制——一次改到位，不用连点几次。
    偏差超过 est 的一半时附 warning，提醒先看看最近几次记录是不是异常。
    跟 est 差不到 5 分钟就不提，免得天天弹。
    """
    # 实例 = 每条 loop 任务行自己（勾掉后会自动长下一件，所以 done 的每条都是一期）；
    # 实际工时按 task_id 汇总整个实例，跨多天投入也完整计入；归属日只看完成日。
    groups = {}
    for t in conn.execute(f"SELECT * FROM tasks t WHERE {loop_sql()} ORDER BY id"):
        key = (t["project_id"], t["title"])
        g = groups.get(key)
        if not g:
            g = groups[key] = {"live": None, "samples": []}
        if not t["done"]:
            g["live"] = t          # 还在跑的那件：采用建议就改它的 estimate_min
        else:
            ld = logical_date(t["done_at"], h)
            if ld is None:
                continue
            r = conn.execute(
                "SELECT SUM(minutes) m FROM work_logs WHERE task_id=?",
                (t["id"],)).fetchone()
            actual = int((r["m"] if r else 0) or 0)
            if actual <= 0:
                continue           # 没计时：不进样本
            g["samples"].append({"date": ld.isoformat(), "actual": actual,
                                 "done_at": t["done_at"] or ""})

    items = []
    for (pid, title), g in groups.items():
        cur = g["live"] or None
        samples = sorted(g["samples"], key=lambda s: s["done_at"], reverse=True)[:CALIB_WINDOW]
        if cur is None:
            # 没有在跑的实例（被删过/只剩完成态）：拿最近一条完成态当目标行
            row = conn.execute(
                f"SELECT * FROM tasks t WHERE t.project_id IS ? AND t.title=? AND {loop_sql()} "
                "ORDER BY id DESC LIMIT 1", (pid, title)).fetchone()
            cur = row
        est = cur["estimate_min"] if cur else None
        n = len(samples)
        mean = int(round(sum(s["actual"] for s in samples) / n)) if n else 0
        suggestion = None
        short = est is not None and est < CALIB_MIN_EST
        if cur is not None and n >= CALIB_MIN_N and not short:
            # 一次到位：建议值就是均值舍入到 5 的倍数（下限至少 5 分钟，预估必须 > 0）
            suggested = max(5, _round5(mean))
            if est is None or abs(suggested - est) >= 5:
                suggestion = {
                    "est_new": suggested,
                    "direction": "低估" if (est is None or suggested > est) else "高估",
                    "delta_min": (suggested - est) if est is not None else None,
                }
                # 偏差过大时只提醒、不拦着：均值可能被一两次异常记录拉偏
                if est and abs(mean - est) / est > CALIB_WARN_RATIO:
                    suggestion["warning"] = "差得比较多，建议先看看最近几次记录是不是异常"
        items.append({
            "task_id": cur["id"] if cur is not None else None,
            "project_id": pid,
            "title": title,
            "est": est,
            "samples": n,
            "mean_actual": mean,
            "last7": [s["actual"] for s in samples],
            "short_est": short,     # 预估太短，这个任务不校准（前端据此改文案）
            "suggestion": suggestion,
        })
    items.sort(key=lambda it: (it["suggestion"] is None, -(it["samples"] or 0)))
    return items


def tag_stats(conn, today: date, h: int, since: date) -> list:
    """按标签算「均次耗时」（v0.19.8，v0.19.9 起按项目拆开，只读）。

    件数按任务行算：loop 任务勾掉后会自己长下一件，每条天然是一期，不用再归并。
    完成实例按 done_at 归到所属逻辑日，只看 since 之后；整个 task_id 实例的工时都算，
    跨天投入也不会漏。没计时单独记 untimed_done——「没计时」不等于「做得快」，
    跟 loop 校准同口径。没完成的在窗口内的工时记 wip_min，计入总耗时但不计件数。

    先按 (项目, 标签) 归堆出明细，再按标签把明细加起来当汇总行：两层用的是同一
    份账，只是分组键不同，所以汇总行永远等于各项目行之和。同名标签跨项目时（qc
    在 Neogen 和在别的项目不是一类活）就靠这个分母分开看。

    v0.20.1 起分组键一律用小写（「QC」「qc」算同一个标签），但显示的是原样：
    同一组里哪种写法出现得多就用哪种，票数并列取先出现的（dict 保插入序）。
    """
    names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM projects")}
    buckets = {}
    for t in conn.execute(
            "SELECT * FROM tasks WHERE COALESCE(suspended,0)=0 "
            "AND tags IS NOT NULL AND tags!=''"):
        tags = tag_list(t["tags"])
        if not tags:
            continue
        # 一件任务先把自己的账算一遍（跟标签无关），再摊到它的每个标签上：
        # 既不重复查工时，也不会因为某个标签跳过而漏掉同一件的其它标签
        done_min = untimed = wip_min = 0
        if t["done"]:
            ld = logical_date(t["done_at"], h)
            if ld is not None and ld >= since:
                r = conn.execute(
                    "SELECT SUM(minutes) m FROM work_logs WHERE task_id=?",
                    (t["id"],)).fetchone()
                done_min = int((r["m"] if r else 0) or 0)
                untimed = 1 if done_min <= 0 else 0
        else:
            r = conn.execute(
                "SELECT SUM(minutes) m FROM work_logs WHERE task_id=? AND date>=?",
                (t["id"], since.isoformat())).fetchone()
            wip_min = int((r["m"] if r else 0) or 0)
        for tg in tags:
            key = (t["project_id"], tg.lower())
            b = buckets.get(key)
            if b is None:
                b = buckets[key] = {
                    "task_count": 0, "done_count": 0, "done_min": 0,
                    "untimed_done": 0, "wip_min": 0, "ests": [], "votes": {}}
            b["votes"][tg] = b["votes"].get(tg, 0) + 1
            b["task_count"] += 1
            if done_min > 0:
                b["done_count"] += 1
                b["done_min"] += done_min
                if t["estimate_min"] is not None:
                    b["ests"].append(t["estimate_min"])
            elif untimed:
                b["untimed_done"] += 1
            b["wip_min"] += wip_min
    # 一层明细行（项目 + 标签）
    details = {}
    for (pid, key), b in buckets.items():
        row = project_row(pid, names.get(pid), b)
        row["tag"] = _top_tag(b["votes"])
        details[(pid, key)] = row
    # 二层汇总：按标签把明细加起来
    by_tag = {}
    for (pid, key), b in buckets.items():
        it = by_tag.get(key)
        if it is None:
            it = by_tag[key] = {"task_count": 0, "done_count": 0, "done_min": 0,
                                "untimed_done": 0, "wip_min": 0, "ests": [],
                                "projects": [], "votes": {}}
        for k in ("task_count", "done_count", "done_min", "untimed_done", "wip_min"):
            it[k] += b[k]
        it["ests"].extend(b["ests"])
        for name, cnt in b["votes"].items():
            it["votes"][name] = it["votes"].get(name, 0) + cnt
        it["projects"].append(details[(pid, key)])
    items = []
    for key, it in by_tag.items():
        n = it["done_count"]
        it["projects"].sort(key=lambda p: (-p["total_min"], p["project_name"]))
        items.append({
            "tag": _top_tag(it["votes"]),
            "task_count": it["task_count"],
            "done_count": n,
            "total_min": it["done_min"] + it["wip_min"],
            # 均次只按「完成且计时」算；mean_est 取同一批样本的预估，才好比
            "mean_min": int(round(it["done_min"] / n)) if n else None,
            "mean_est": int(round(sum(it["ests"]) / len(it["ests"]))) if it["ests"] else None,
            "untimed_done": it["untimed_done"],
            "wip_min": it["wip_min"],
            "projects": it["projects"],
        })
    # 次级键用小写：同一标签的大写/小写写法归在一起，排序不能跟着写法摇
    items.sort(key=lambda it: (-it["total_min"], it["tag"].lower()))
    return items


def _top_tag(votes: dict) -> str:
    """一组标签里显示哪个写法：票数最多的；并列取先出现的（dict 保插入序）。"""
    best, top = "", 0
    for name, cnt in votes.items():
        if cnt > top:
            best, top = name, cnt
    return best


def project_row(pid, name, b) -> dict:
    """标签统计的项目明细行：字段跟汇总行同一套，多一个项目名（tag 由调用方填）。"""
    n = b["done_count"]
    return {
        "project_id": pid,
        "project_name": proj_name(pid, name),
        "task_count": b["task_count"],
        "done_count": n,
        "total_min": b["done_min"] + b["wip_min"],
        "mean_min": int(round(b["done_min"] / n)) if n else None,
        "mean_est": int(round(sum(b["ests"]) / len(b["ests"]))) if b["ests"] else None,
        "untimed_done": b["untimed_done"],
        "wip_min": b["wip_min"],
    }


def build_state() -> dict:
    conn = db()
    h = day_start_hour(conn)
    lan_on = lan_access_enabled(conn)
    # 只有「今天该干什么」（今日排期列表、今日建议）按真实日期 0 点翻页；
    # 安全线、已投入、统计这些工时账仍按逻辑日（凌晨算前一天）
    today = logical_today(conn)
    rtoday = real_today()
    # 有 due 没排期的任务自动排到 due 那天（一次性迁移 + 兜底；日历=可视化+调整用）
    # no_autosched=1 的是用户主动放回池子的，不要再钉回去
    conn.execute(
        "UPDATE tasks SET scheduled_date=due_date "
        "WHERE done=0 AND due_date IS NOT NULL AND scheduled_date IS NULL "
        "AND project_id IS NOT NULL AND COALESCE(no_autosched,0)=0")
    # 日常跳勾不失踪：没做完的日常排期停在昨天（及更早）时，顺延到最近适用日
    # （每工作日版跳过周末/节假日），照常进今日排期和安全线结算。用户主动排到
    # 未来的不动。排期变了之后撤销那次完成会按「用户动过」保留下一件——合理，
    # 它本来就是今天该做的实例
    for stuck in conn.execute(
            "SELECT id, workday_only FROM tasks WHERE done=0 AND routine=1 "
            "AND COALESCE(suspended,0)=0 AND scheduled_date IS NOT NULL "
            "AND scheduled_date<?", (rtoday.isoformat(),)).fetchall():
        nd = rtoday
        if stuck["workday_only"]:
            while not is_workday(nd):
                nd += timedelta(days=1)
        conn.execute("UPDATE tasks SET scheduled_date=? WHERE id=?",
                     (nd.isoformat(), stuck["id"]))
    # 老数据只标了 suspended 没记 suspended_at：从今天起计「挂了几天」，
    # 不然界面永远显示「已挂起 —」，看起来就像累计搁置天数被清了
    conn.execute(
        "UPDATE tasks SET suspended_at=? WHERE suspended=1 AND suspended_at IS NULL",
        (rtoday.isoformat(),))
    conn.commit()
    no_track_ids = {r["id"] for r in conn.execute("SELECT id FROM projects WHERE no_track=1")}
    # 动态结算：勾掉的日常按实际工时降安全线（默认开）。关掉 = 回到纯预估的老口径
    r = conn.execute("SELECT value FROM settings WHERE key='dynamic_routine_settlement'").fetchone()
    dyn_settle = not r or r["value"] == "1"
    # 今日 loop 实例结算（一次全表遍历）：项目安全线、绿区宽度、超预估角标都从这儿出
    routine_pending, routine_done = settle_loop_today(conn, today, h, no_track_ids)
    loop_plan_by_proj, loop_settled_by_proj = {}, {}
    for it in routine_pending + routine_done:
        pid = it["project_id"]
        loop_plan_by_proj[pid] = loop_plan_by_proj.get(pid, 0) + (it["est"] or 0)
        loop_settled_by_proj[pid] = loop_settled_by_proj.get(pid, 0) + it["settled"]
    # 绿区/角标/主判定只认进安全线的那部分：不计工时的项目和 inbox（无项目）日常不进，
    # 和 total_safety_min 的口径对齐（数组 routine_pending/routine_done 仍是全量，带 tracked 标记）
    tracked_items = [it for it in routine_pending + routine_done if it["tracked"]]
    r_pending = [it for it in tracked_items if not it["done"]]
    r_done = [it for it in tracked_items if it["done"]]
    routine_plan_min = sum(it["est"] or 0 for it in tracked_items)
    routine_settled_min = sum(it["settled"] for it in tracked_items)
    routine_over_est_min = sum(it["over_est"] for it in tracked_items)
    routine_noest_actual_min = sum(
        it["actual"] for it in r_done if it["est"] is None and it["actual"])
    routine_pending_count = len(r_pending)
    routine_pending_est_min = sum(it["est"] or 0 for it in r_pending)
    routine_pending_noest_count = sum(1 for it in r_pending if it["est"] is None)
    routine_done_count = len(r_done)
    routine_done_actual_min = sum(it["actual"] for it in r_done)
    # 「实际 Xm / 预估 Ym（少 Zm）」只在有预估的实例之间比：无预估的实际工时单独走角标
    routine_done_actual_est_min = sum(it["actual"] for it in r_done if it["est"] is not None)
    routine_done_est_min = sum(it["est"] or 0 for it in r_done)
    routine_done_noactual_count = sum(1 for it in r_done if not it["has_actual"])
    projects = []
    total_safety = 0
    total_routine = 0
    # 一次性任务已记工时：安全线的项目剩余量/摊量都按「剩余预估」（预估 − 已做），
    # 与 loop 结算、下一件推荐同口径——全链路只看还欠多少，做过的不重复收
    task_done_min = {r["task_id"]: r["m"] for r in conn.execute(
        "SELECT task_id, SUM(minutes) m FROM work_logs "
        "WHERE task_id IS NOT NULL GROUP BY task_id")}
    for p in conn.execute("SELECT * FROM projects ORDER BY sort_order, id"):
        open_tasks = conn.execute(
            "SELECT * FROM tasks WHERE project_id=? AND done=0 ORDER BY id", (p["id"],)
        ).fetchall()
        done_tasks = conn.execute(
            "SELECT * FROM tasks WHERE project_id=? AND done=1 ORDER BY done_at DESC LIMIT 200", (p["id"],)
        ).fetchall()
        # 挂起的不占项目剩余量：它今天推不动，算进剩余量只会把 deadline / 安全线一起撑高
        remaining = sum(max(est_min(t) - (task_done_min.get(t["id"], 0) or 0), 0)
                        for t in open_tasks if not is_loop(t) and not t["suspended"])
        days_left = safety = eff = slack = None
        wo = bool(p["workdays_only"])  # 仅工作日计算：周末节假日不折算出必需量
        if p["deadline"]:
            dl = date.fromisoformat(p["deadline"])
            days_left = count_workdays(today, dl) if wo else (dl - today).days
            eff = effective_days(max(0, days_left))
            safety = math.ceil(remaining / eff) if remaining else 0
            eff2 = effective_days(max(0, days_left - 1))
            slack = math.ceil(remaining / eff2) if remaining else 0
        else:
            # 持续型项目：每个带 due 的任务把「剩余预估」（预估 − 已做）摊到距 due 的
            # 每一天，按优先级加权（高 ×1.5 / 中 ×1.2 / 低 ×0.9：重要的事把安全线推高，
            # 琐事拉低）。做满没勾的剩余归 0，不再占线
            share_sum = 0.0
            for t in open_tasks:
                # 提前量（same_day 即提前 0 天）：没到窗口起点之前不算进安全线，
                # 提前摊进来只会让今天凭空多出一笔干不了的量。挂起的同理：等回复的事
                # 今天干不了，算进安全线只会让每天都在追一笔追不上的量
                if is_loop(t) or t["suspended"] or not lead_active(t, today):
                    continue
                due = date.fromisoformat(t["due_date"])
                days_to = count_workdays(today, due + timedelta(days=1)) if wo \
                    else (due - today).days + 1
                w = {5: 1.5, 3: 1.2, 1: 0.9}.get(t["priority"] or 0, 1.0)
                left = max(est_min(t) - (task_done_min.get(t["id"], 0) or 0), 0)
                share_sum += left * w / max(1, days_to)
            safety = math.ceil(share_sum)
        # 日常/重复（loop）任务今天的实例量作为每日基础工时，加在安全线上：
        # loop 也是每天要真实花的时间，不计入会让安全线看起来够、其实不够。
        # 动态结算开着时用结算值（勾掉且有计时的实例按 min(实际, 预估)，干完就真的降下来；
        # 没计时的仍按预估，没计时不等于做得快）；关掉就用 loop_today_min 的纯预估合计
        routine_plan = loop_today_min(open_tasks + done_tasks, today, h)
        routine_today = loop_settled_by_proj.get(p["id"], 0) if dyn_settle else routine_plan
        if safety is not None:
            safety += routine_today
        if wo and not is_workday(today):
            # 今天不是工作日：不排必需量（要加班照常记工时）。slack 一并归零，
            # 免得前端提示「再拖一天每天涨到 X」这种今天本来就做不到的催促
            safety = 0
            slack = 0
        if safety is not None and p["id"] not in no_track_ids:
            total_safety += safety
            total_routine += routine_today
        invested_today = conn.execute(
            "SELECT COALESCE(SUM(minutes),0) s FROM work_logs WHERE project_id=? AND date=?",
            (p["id"], today.isoformat()),
        ).fetchone()["s"]
        invested_all = conn.execute(
            "SELECT COALESCE(SUM(minutes),0) s FROM work_logs WHERE project_id=?", (p["id"],)
        ).fetchone()["s"]
        projects.append({
            "id": p["id"], "name": p["name"], "color": p["color"],
            "deadline": p["deadline"], "days_left": days_left,
            "no_track": p["no_track"],
            "workdays_only": p["workdays_only"],
            "remaining_min": remaining, "effective_days": eff,
            "safety_min": safety, "slack_min": slack,
            "routine_today_min": routine_today,
            "routine_plan_min": routine_plan,
            "today_invested_min": invested_today, "total_invested_min": invested_all,
            "tasks": [dict(t) for t in open_tasks],
            "done_tasks": [dict(t) for t in done_tasks],
        })

    # 「必做」只收一次性任务：due 今天或已逾期才计入，日常/周期重复单独展示。
    # 与今日列表一样按真实日期判断；挂起、不计工时项目和 inbox 不进 hero 的必做合计。
    today_iso = rtoday.isoformat()
    must_do = [
        t for pr in projects if pr["id"] not in no_track_ids
        for t in pr["tasks"]
        if not is_loop(t) and not t["suspended"] and t["due_date"]
        and t["due_date"] <= today_iso
    ]
    must_do_count = len(must_do)
    must_do_est_min = sum(est_min(t) for t in must_do)
    must_do_noest_count = sum(1 for t in must_do if t["estimate_min"] is None)
    must_do_overdue_count = sum(1 for t in must_do if t["due_date"] < today_iso)

    # 每日鞭策仍沿用安全线清空口径；它和上面的「due 必做」是两种提醒。
    routine_cleared = (
        routine_pending_count == 0 and routine_pending_est_min == 0
        and max(0, total_safety - total_routine) <= 0)

    timer = conn.execute("""
        SELECT w.id AS log_id, w.task_id, w.project_id, w.start_at, t.title AS task_title
        FROM work_logs w LEFT JOIN tasks t ON t.id=w.task_id
        WHERE w.end_at IS NULL AND w.start_at IS NOT NULL LIMIT 1
    """).fetchone()

    since = (today - timedelta(days=13)).isoformat()
    by_day = {r["date"]: r["m"] for r in conn.execute(
        "SELECT date, SUM(minutes) m FROM work_logs WHERE date>=? GROUP BY date", (since,)
    )}
    r = conn.execute("SELECT value FROM settings WHERE key='daily_target_min'").fetchone()
    daily_target = int(r["value"]) if r else 480
    r = conn.execute("SELECT value FROM settings WHERE key='show_project_prefix'").fetchone()
    show_prefix = not r or r["value"] == "1"  # 默认开启
    r = conn.execute("SELECT value FROM settings WHERE key='show_dual_track'").fetchone()
    show_dual = not r or r["value"] == "1"  # 默认开启：计划/实际分两条横条
    # hero 下「下一件推荐」列几件：默认 3，非法值（没写、非数字、越界）一律回落
    r = conn.execute("SELECT value FROM settings WHERE key='next_suggest_count'").fetchone()
    try:
        next_suggest = int(r["value"]) if r else 3
    except (TypeError, ValueError):
        next_suggest = 3
    if not 1 <= next_suggest <= 5:
        next_suggest = 3
    # 最近 14 天每天里的日常/重复（loop）工时：图上把它单独叠出来，看得到基础盘有多大
    # （被删掉的 loop 任务留下的孤儿记录 JOIN 不上，算非 loop，不影响总数）
    routine_by_day = {r["date"]: r["m"] for r in conn.execute(
        "SELECT w.date AS date, SUM(w.minutes) m FROM work_logs w JOIN tasks t ON t.id=w.task_id "
        f"WHERE w.date>=? AND {loop_sql()} GROUP BY w.date", (since,))}
    recent = [{"date": (today - timedelta(days=i)).isoformat(),
               "minutes": by_day.get((today - timedelta(days=i)).isoformat(), 0),
               "routine": routine_by_day.get((today - timedelta(days=i)).isoformat(), 0)}
              for i in range(13, -1, -1)]

    invested_by_date = {r["date"]: r["m"] for r in conn.execute(
        "SELECT date, SUM(minutes) m FROM work_logs GROUP BY date")}

    # 不计工时的项目不进 hero 合计和连续达标
    def track_cond(pre=""):
        if not no_track_ids:
            return "1=1"
        return "(%sproject_id IS NULL OR %sproject_id NOT IN (%s))" % (
            pre, pre, ",".join(str(i) for i in no_track_ids))
    cond = track_cond()
    total_invested = conn.execute(
        f"SELECT COALESCE(SUM(minutes),0) s FROM work_logs WHERE date=? AND {cond}",
        (today.isoformat(),)).fetchone()["s"]
    invested_track = {r["date"]: r["m"] for r in conn.execute(
        f"SELECT date, SUM(minutes) m FROM work_logs WHERE {cond} GROUP BY date")}
    # 今天投在日常/重复（loop）任务上的分钟数：hero 把已投入拆成「日常·重复 / 项目推进」两段。
    # 任务被删或没关联的工时 JOIN 不上，算「项目推进」，与上面的口径一致
    routine_invested = conn.execute(
        f"SELECT COALESCE(SUM(w.minutes),0) s FROM work_logs w "
        f"LEFT JOIN tasks t ON t.id=w.task_id "
        f"WHERE w.date=? AND {loop_sql()} AND {track_cond('w.')}",
        (today.isoformat(),)).fetchone()["s"]

    # 两种达标挑战共用实际投入，但阈值各自独立。安全线当天随任务结算更新，翻到下一条
    # 逻辑日后保留最后一次值；过去没有留存安全线的日子不猜、不回填。0 需求日不计挑战。
    conn.execute(
        "INSERT INTO daily_safety_lines(date, safety_min) VALUES(?, ?) "
        "ON CONFLICT(date) DO UPDATE SET safety_min=excluded.safety_min",
        (today.isoformat(), total_safety))
    conn.commit()
    safety_by_date = {r["date"]: r["safety_min"] for r in conn.execute(
        "SELECT date, safety_min FROM daily_safety_lines")}

    def target_met(d: date) -> bool:
        return invested_track.get(d.isoformat(), 0) >= daily_target

    def safety_met(d: date) -> bool:
        line = safety_by_date.get(d.isoformat())
        return line is not None and line > 0 and invested_track.get(d.isoformat(), 0) >= line

    streak = count_challenge_streak(today, target_met)
    safety_streak = count_safety_streak(today, safety_by_date, invested_track)

    # done_at 是真实时间戳：先把查询缩到逻辑日对应的真实窗口，再按逻辑日归组
    # （勾掉的任务算谁的账跟着工时走：凌晨勾掉算前一天）
    lo, hi = logical_day_bounds(today, h)
    done_today = sum(
        1 for r in conn.execute(
            "SELECT done_at FROM tasks WHERE done=1 AND done_at>=? AND done_at<?", (lo, hi))
        if logical_date(r["done_at"], h) == today)
    inbox = [dict(t) for t in conn.execute(
        "SELECT * FROM tasks WHERE project_id IS NULL AND done=0 ORDER BY id")]

    # 今日建议：带 due 的非 loop 任务按 剩余天数+优先级 折算出今天该投的分钟数
    # 「今天」按真实日期算，跟今日排期列表同一页同一口径。
    # 按「剩余预估」摊：这件已记的工时从预估里扣（与周期重复的结算口径一致），
    # 做满没勾的份额归 0 自动退出推荐——等于提醒该勾了
    plan = []
    plan_done_min = {r["task_id"]: r["m"] for r in conn.execute(
        "SELECT task_id, SUM(minutes) m FROM work_logs "
        "WHERE task_id IS NOT NULL GROUP BY task_id")}
    # 分档阈值（0 = 不分档）和用户指定优先顺序：只影响「怎么排、怎么折」，份额和安全线一分不动
    small_threshold = recommend_min_minutes(conn)
    order_ids = recommend_project_ids(conn)
    proj_rank = {pid: i for i, pid in enumerate(order_ids)}
    for pr in projects:
        if pr["id"] in no_track_ids:
            continue
        for t in pr["tasks"]:
            # 提前量：没到窗口起点不做建议（due 当天它已排期进「今天」，走不到这里）
            # 挂起的也不建议：等回复的事给不出「今天投多少分钟」
            if is_loop(t) or t["suspended"] or not t["due_date"] \
                    or t["scheduled_date"] == rtoday.isoformat() \
                    or not lead_active(t, rtoday):
                continue
            due = date.fromisoformat(t["due_date"])
            days_to = count_workdays(rtoday, due + timedelta(days=1)) if pr["workdays_only"] \
                else (due - rtoday).days + 1
            w = {5: 1.5, 3: 1.2, 1: 0.9}.get(t["priority"] or 0, 1.0)
            est = est_min(t)
            remaining = max(est - (plan_done_min.get(t["id"], 0) or 0), 0)
            share = min(remaining, math.ceil(remaining * w / max(1, days_to)))
            # 小额也照列（原来 share<5 就 continue，序号会断裂），但 0 分钟的退化情形
            # 不算建议——预估没填，或剩余已经做没了
            if share <= 0:
                continue
            # 小额分档：份额小到不值得单独占一行，就折进「另有 N 件小额」。两个豁免——
            # 本来就是小任务（est < 阈值，折进去等于把它藏起来）和快到期/已逾期
            # （距 due ≤2 天，这时候再小也得做）。阈值 0 = 不分档，全部留在主建议里。
            # days_to 是含今天的口径（due 今天 = 1），所以「距 due ≤2 天」= days_to ≤ 3
            small = (small_threshold > 0 and share < small_threshold
                     and est >= small_threshold and days_to > 3)
            plan.append({
                "task_id": t["id"], "title": t["title"],
                "project_id": pr["id"],
                "project": pr["name"], "color": pr["color"],
                "minutes": share, "due_date": t["due_date"],
                "overdue": t["due_date"] < rtoday.isoformat(),
                "priority": t["priority"] or 0,
                "small": small,
            })
    # 排序：due → 任务优先级 → 用户指定的项目顺序 → 建议分钟。没被指定优先的项目
    # 用同一个常数当键，稳定排序因此保留它们原有的相对顺序（按 id），不会被搅乱
    plan.sort(key=lambda x: (x["due_date"], -x["priority"],
                             proj_rank.get(x["project_id"], len(proj_rank)),
                             -x["minutes"]))
    # 全局序号：建议按项目分组塞进各项目卡后，序号是唯一能看出「先做哪个」的线索，
    # 所以不做小额过滤（过滤掉会让序号断裂），排序也就是推荐顺序
    for i, it in enumerate(plan, 1):
        it["rank"] = i
    # 分档后的两份：today_plan 仍是完整有序表（每项带 small 标记，rank 连续），
    # 前端主推荐用 main_plan、「另有 N 件小额」用 small_plan
    main_plan = [it for it in plan if not it["small"]]
    small_plan = [it for it in plan if it["small"]]

    # ── 结算预览（占位口径，只算给你看，不参与安全线判定）──────────────────────
    # 明细在上面 settle_loop_today() 一次算好（数组是全量的，含不计工时项目和 inbox 日常）；
    # 这里只做聚合：settle_preview 沿用 v0.18.8 的全量口径，routine_* 那组是进安全线的部分
    settle_preview = {
        "pending_est_min": sum(i["est"] or 0 for i in routine_pending),
        "pending_count": len(routine_pending),
        "pending_noest_count": sum(1 for i in routine_pending if i["est"] is None),
        "done_actual_min": sum(i["actual"] for i in routine_done),
        "done_est_min": sum(i["est"] or 0 for i in routine_done),
        "done_settled_min": sum(i["settled"] for i in routine_done),
        "done_noactual_count": sum(1 for i in routine_done if not i["has_actual"]),
    }
    # 同步/更新设置也进 state：在 conn 还开着的时候先读出来
    sync_peer = sync_peer_url(conn)
    sync_device = sync_device_name(conn)
    upd_enabled = update_enabled(conn)
    upd_url = update_url(conn)
    go_url = pace_go_url(conn)
    conn.close()
    return {
        "today": rtoday.isoformat(),
        "logical_today": today.isoformat(),
        "now": datetime.now().isoformat(timespec="seconds"),
        "total_safety_min": total_safety,
        "total_routine_today_min": total_routine,
        "today_routine_invested_min": routine_invested,
        "total_invested_min": total_invested,
        "active_timer": dict(timer) if timer else None,
        "projects": projects,
        "recent_days": recent,
        "invested_by_date": invested_by_date,
        "today_is_workday": is_workday(rtoday),  # 前端拿它筛今日日常：跟真实日期走
        "day_start_hour": h,
        "daily_target_min": daily_target,
        "streak_days": streak,  # 兼容旧前端：仍指日目标挑战
        "target_streak_days": streak,
        "safety_streak_days": safety_streak,
        "target_met_today": target_met(today),
        "safety_met_today": safety_met(today),
        "safety_skipped_today": total_safety == 0,
        "done_today_count": done_today,
        "inbox": inbox,
        "today_plan": plan,
        "main_plan": main_plan,
        "small_plan": small_plan,
        "recommend_min_minutes": small_threshold,
        "recommend_project_ids": order_ids,
        "version": VERSION,
        "show_project_prefix": show_prefix,
        "show_dual_track": show_dual,
        "next_suggest_count": next_suggest,
        "must_do_count": must_do_count,
        "must_do_est_min": must_do_est_min,
        "must_do_noest_count": must_do_noest_count,
        "must_do_overdue_count": must_do_overdue_count,
        "must_do_cleared": must_do_count == 0,
        "routine_pending": routine_pending,
        "routine_done": routine_done,
        "settle_preview": settle_preview,
        # 动态结算：进安全线那部分的口径（绿区宽度、超预估/无预估角标、主判定用）
        "dynamic_routine_settlement": dyn_settle,
        "routine_settled_min": routine_settled_min,
        "routine_over_est_min": routine_over_est_min,
        "routine_noest_actual_min": routine_noest_actual_min,
        "routine_plan_min": routine_plan_min,
        "routine_pending_count": routine_pending_count,
        "routine_pending_est_min": routine_pending_est_min,
        "routine_pending_noest_count": routine_pending_noest_count,
        "routine_done_count": routine_done_count,
        "routine_done_actual_min": routine_done_actual_min,
        "routine_done_actual_est_min": routine_done_actual_est_min,
        "routine_done_est_min": routine_done_est_min,
        "routine_done_noactual_count": routine_done_noactual_count,
        "routine_cleared": routine_cleared,
        "autostart": startup_vbs_path().exists(),
        # 局域网：lan_access = 配置，lan_runtime = 这一进程真的绑在哪。不一致 = 改了开关
        # 还没重启（这正是「关了开关手机还能连」的根源），前端要显式提示「已保存、待重启」
        "lan_access": lan_on,
        "lan_runtime": lan_runtime(lan_on),
        "lan_restart_pending": lan_runtime(lan_on) != lan_on,
        # lan_url 保持老语义（按配置给，关掉就是 null），旧调用方不受影响；lan_url_runtime 是
        # 「现在真能连的地址」：关了但还没重启时它仍有值——页面确实还能被手机打开
        "lan_url": lan_url_text() if lan_on else None,
        "lan_url_runtime": lan_url_text() if lan_runtime(lan_on) else None,
        "backup": backup_state(),
        "sync_peer": sync_peer,
        "sync_device": sync_device,
        "update_enabled": upd_enabled,
        "update_url": upd_url,
        "pace_go_url": go_url,
        "dev_no_update": is_dev_machine(),
    }


# ── 历史数据导出：只读查询，不改库 ────────────────────────────────────────────
# 导出用列白名单而不是黑名单：gen_snapshot 这些
# 从「没列出来」这一条就自动排除了，以后加列也不会顺手漏出去。
EXPORT_SCHEMA_VERSION = 1
EXPORT_MASKS = ("none", "projects", "content")
PROJECT_COLS = ("id", "name", "color", "deadline", "created_at",
                "workdays_only", "no_track", "sort_order")
TASK_COLS = ("id", "project_id", "title", "detail", "estimate_min", "done", "done_at",
             "created_at", "due_date", "scheduled_date", "routine", "workday_only",
             "same_day", "lead_days", "priority", "tags", "repeat_type",
             "repeat_weekday", "repeat_monthday", "repeat_ordinal", "skip_holiday",
             "repeat_interval", "suspended", "suspended_at", "gen_from")
LOG_COLS = ("id", "project_id", "task_id", "date", "minutes",
            "start_at", "end_at", "note", "task_name")


def export_parse_args(body) -> dict:
    """校验并归一化导出参数。所有非法输入都抛 ValueError（接口回 400 中文）。"""
    fmt = str(body.get("format") or "json").strip().lower()
    if fmt not in ("json", "xlsx"):
        raise ValueError("format 只能是 json 或 xlsx")
    mask = str(body.get("mask") or "none").strip().lower()
    if mask not in EXPORT_MASKS:
        raise ValueError("mask 只能是 none、projects、content")
    raw_ids = body.get("project_ids", None)
    ids = None            # None = 全部项目（缺省 / 显式 null 都一样）
    if raw_ids is not None:
        if not isinstance(raw_ids, list):
            raise ValueError("project_ids 要是数组，或者留空表示全部项目")
        ids = []
        for v in raw_ids:
            if isinstance(v, bool) or not isinstance(v, (int, float, str)):
                raise ValueError("project_ids 里有不是数字的项目 id")
            try:
                n = int(v)
            except (TypeError, ValueError):
                raise ValueError("project_ids 里有不是数字的项目 id")
            if n not in ids:
                ids.append(n)
    inbox = bool(body.get("include_inbox"))
    d_from = (body.get("date_from") or "").strip() or None
    d_to = (body.get("date_to") or "").strip() or None
    for label, v in (("起始日期", d_from), ("结束日期", d_to)):
        if not v:
            continue
        if len(v) != 10:
            raise ValueError(f"{label}格式应为 YYYY-MM-DD")
        try:
            date.fromisoformat(v)
        except ValueError:
            raise ValueError(f"{label}格式应为 YYYY-MM-DD")
    if d_from and d_to and d_from > d_to:   # 都是 YYYY-MM-DD，直接按字符串比就是日期序
        raise ValueError("起始日期不能晚于结束日期")
    full = ids is None
    if not full and not ids and not inbox:
        raise ValueError("没选任何项目：至少选一个项目，或勾上「未分配」")
    return {"format": fmt, "mask": mask, "full": full, "project_ids": ids,
            "include_inbox": inbox, "date_from": d_from, "date_to": d_to}


def export_collect(conn, f) -> list:
    """按筛选捞三张表。projects / tasks 是全量上下文，只有 work_logs 受日期范围限制。

    全量（project_ids 缺省）：项目、任务、工时全部导出，含未分配的、以及
    已删除项目/任务留下的孤儿工时。按项目筛选：只含所选项目，另可勾未分配。
    """
    if f["full"]:
        projects = [dict(r) for r in conn.execute(
            f"SELECT {','.join(PROJECT_COLS)} FROM projects ORDER BY id")]
        tasks = [dict(r) for r in conn.execute(
            f"SELECT {','.join(TASK_COLS)} FROM tasks ORDER BY id")]
        scope_sql, scope_args = "", []
    else:
        ids = f["project_ids"] or []
        if ids:
            marks = ",".join("?" * len(ids))
            projects = [dict(r) for r in conn.execute(
                f"SELECT {','.join(PROJECT_COLS)} FROM projects "
                f"WHERE id IN ({marks}) ORDER BY id", ids)]
        else:
            projects = []
        conds, scope_args = [], []
        if ids:
            conds.append(f"project_id IN ({','.join('?' * len(ids))})")
            scope_args.extend(ids)
        if f["include_inbox"]:
            conds.append("project_id IS NULL")
        # conds 为空只有「空列表且不含未分配」这一种，前面已经 400 掉了；留着 0=1 兜底
        scope_sql = " AND (" + " OR ".join(conds) + ")" if conds else " AND 0=1"
        tasks = [dict(r) for r in conn.execute(
            f"SELECT {','.join(TASK_COLS)} FROM tasks WHERE 1=1{scope_sql} ORDER BY id",
            list(scope_args))]
    sql = f"SELECT {','.join(LOG_COLS)} FROM work_logs WHERE 1=1{scope_sql}"
    args = list(scope_args)
    if f["date_from"]:
        sql += " AND date>=?"
        args.append(f["date_from"])
    if f["date_to"]:
        sql += " AND date<=?"
        args.append(f["date_to"])
    sql += " ORDER BY date, id"
    logs = [dict(r) for r in conn.execute(sql, args)]
    return [projects, tasks, logs]


def export_settings(conn) -> dict:
    """只带算分析用得上的四项，且都换算成生效值：日目标、新一天从几点算、
    动态结算开关、下一件推荐条数。绝不整表导出（表里有滴答 token 这类东西）。"""
    r = conn.execute("SELECT value FROM settings WHERE key='daily_target_min'").fetchone()
    try:
        target = int(r["value"]) if r else 480
    except (TypeError, ValueError):
        target = 480
    r = conn.execute(
        "SELECT value FROM settings WHERE key='dynamic_routine_settlement'").fetchone()
    dyn = not r or r["value"] != "0"
    r = conn.execute("SELECT value FROM settings WHERE key='next_suggest_count'").fetchone()
    try:
        nxt = int(r["value"]) if r else 3
    except (TypeError, ValueError):
        nxt = 3
    if not 1 <= nxt <= 5:
        nxt = 3
    return {"daily_target_min": target, "day_start_hour": day_start_hour(conn),
            "dynamic_routine_settlement": dyn, "next_suggest_count": nxt}


def export_apply_mask(payload, mask):
    """按档位改写名字。占位映射只活在这里，绝不写进导出内容。

    projects：项目名 →「项目 1、项目 2…」（按 id 升序，稳定），任务详情保留
    content ：再把任务名 →「任务 1…」、工时记录里的兜底任务名一起换、
              任务详情和工时备注一起清空（两者都是自由文本，同样会漏内容）
    日期、工时、标签、完成状态一律保留。
    """
    if mask == "none":
        return
    pnum = {p["id"]: f"项目 {i}" for i, p in enumerate(payload["projects"], 1)}
    for p in payload["projects"]:
        p["name"] = pnum[p["id"]]
    if mask != "content":
        return
    tnum = {t["id"]: f"任务 {i}" for i, t in enumerate(payload["tasks"], 1)}
    for t in payload["tasks"]:
        t["title"] = tnum[t["id"]]
        # 详情是自由文本，里面极可能写着客户名、链接、原始需求——和任务名同级处理。
        # projects 档只换项目名，详情保留（那一档的承诺就是「只隐项目」）
        t["detail"] = None
    seq = [len(tnum)]

    def alloc():
        seq[0] += 1
        return f"任务 {seq[0]}"

    by_tid, by_name = {}, {}
    for w in payload["work_logs"]:
        w["note"] = None
        tid = w["task_id"]
        if tid in tnum:
            # 和任务表用同一个占位：两张表还能按 task_id 对上号
            w["task_name"] = tnum[tid]
        elif tid is not None:
            # 已删除任务留下的工时：给它自己的占位，别让几条不同的活塌成一个名字
            if tid not in by_tid:
                by_tid[tid] = alloc()
            w["task_name"] = by_tid[tid]
        elif w["task_name"]:
            # 没有 task_id 的手工记录：按出现顺序编号（按名字排序本身也算漏信息）
            if w["task_name"] not in by_name:
                by_name[w["task_name"]] = alloc()
            w["task_name"] = by_name[w["task_name"]]


def export_payload(conn, f, rows) -> dict:
    projects, tasks, logs = rows
    payload = {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "app": {"name": "日拱一卒", "version": VERSION},
        "mask": f["mask"],
        "filters": {
            "all_projects": f["full"],
            "project_ids": None if f["full"] else f["project_ids"],
            "include_inbox": f["include_inbox"],
            "date_from": f["date_from"], "date_to": f["date_to"],
            "date_field": "work_logs.date",
        },
        "settings": export_settings(conn),
        "totals": {
            "projects": len(projects), "tasks": len(tasks),
            "work_logs": len(logs),
            "minutes": sum(x["minutes"] or 0 for x in logs),
        },
        "projects": projects, "tasks": tasks, "work_logs": logs,
    }
    export_apply_mask(payload, f["mask"])
    return payload


# ── XLSX（Office Open XML）：标准库 zipfile + 手写 XML，不加依赖 ──────────────
_XLSX_CT = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" '
            'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '%s'
            '<Override PartName="/xl/styles.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>')
_XLSX_ROOT_RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                   'relationships"><Relationship Id="rId1" Type="http://schemas.'
                   'openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                   'Target="xl/workbook.xml"/></Relationships>')
# 只留两套字体格式：0 普通、1 表头加粗
_XLSX_STYLES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/'
                '2006/main"><fonts count="2"><font><sz val="11"/>'
                '<name val="Calibri"/></font><font><b/><sz val="11"/>'
                '<name val="Calibri"/></font></fonts><fills count="2"><fill>'
                '<patternFill patternType="none"/></fill><fill><patternFill '
                'patternType="gray125"/></fill></fills><borders count="1"><border/>'
                '</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" '
                'fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2">'
                '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
                '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" '
                'applyFont="1"/></cellXfs>'
                '<cellStyles count="1"><cellStyle name="Normal" xfId="0" '
                'builtinId="0"/></cellStyles></styleSheet>')


def xml_escape(v) -> str:
    """XML 文本转义。XML 1.0 不允许的控制字符直接丢掉，不然整份文件打不开。"""
    out = []
    for ch in str(v):
        if ch == "&":
            out.append("&amp;")
        elif ch == "<":
            out.append("&lt;")
        elif ch == ">":
            out.append("&gt;")
        elif ch == '"':
            out.append("&quot;")
        elif ch == "'":
            out.append("&apos;")
        elif ch in "\t\n\r":
            out.append(ch)
        elif ord(ch) < 0x20:
            continue
        else:
            out.append(ch)
    return "".join(out)


def xlsx_col(i: int) -> str:
    """列号转字母：1→A、27→AA。"""
    s = ""
    while i > 0:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def xlsx_cell(ref: str, v, bold: bool = False) -> str:
    """一个单元格。数字/布尔走数值列，其余一律 inlineStr——文本就是文本，
    以 = + - @ 开头也不会被 Excel 当成公式（真正的防护是不生成 <f> 元素）。"""
    st = ' s="1"' if bold else ""
    if v is None or v == "":
        return ""
    if isinstance(v, bool):
        return f'<c r="{ref}"{st} t="b"><v>{1 if v else 0}</v></c>'
    if isinstance(v, (int, float)):
        return f'<c r="{ref}"{st}><v>{v}</v></c>'
    return (f'<c r="{ref}"{st} t="inlineStr"><is>'
            f'<t xml:space="preserve">{xml_escape(v)}</t></is></c>')


def xlsx_sheet_xml(header, rows) -> str:
    parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
             '<worksheet xmlns="http://schemas.openxmlformats.org/'
             'spreadsheetml/2006/main"><sheetData>']
    cells = "".join(filter(None, (xlsx_cell(f"{xlsx_col(i)}1", v, True)
                                  for i, v in enumerate(header, 1))))
    parts.append(f'<row r="1">{cells}</row>')
    for rn, row in enumerate(rows, 2):
        cells = "".join(filter(None, (xlsx_cell(f"{xlsx_col(i)}{rn}", v)
                                      for i, v in enumerate(row, 1))))
        parts.append(f'<row r="{rn}">{cells}</row>')
    parts.append("</sheetData></worksheet>")
    return "".join(parts)


def xlsx_about_rows(p) -> list:
    """说明表：给人看的口径交代。只写数量和 id，绝不写项目名/任务名（脱敏也不漏）。"""
    f = p["filters"]
    if f["all_projects"]:
        scope = "全部项目"
    else:
        ids = f["project_ids"] or []
        scope = ("仅所选 %d 个（id %s）" % (len(ids), "、".join(str(i) for i in ids))
                 if ids else "不含任何项目")
        scope += "；含未分配" if f["include_inbox"] else "；不含未分配"
    if f["date_from"] and f["date_to"]:
        span = f"{f['date_from']} 至 {f['date_to']}"
    elif f["date_from"]:
        span = f"{f['date_from']} 起"
    elif f["date_to"]:
        span = f"截至 {f['date_to']}"
    else:
        span = "全部日期"
    mask_txt = {"none": "不脱敏",
                "projects": "项目名已换成「项目 N」，任务详情保留",
                "content": "项目名和任务名已换成「项目 N / 任务 N」，"
                           "任务详情和工时备注已清空"}[p["mask"]]
    mins = p["totals"]["minutes"]
    t = p["totals"]
    rows = [
        ["项", "内容"],
        ["导出时间", p["exported_at"]],
        ["应用版本", p["app"]["version"]],
        ["脱敏模式", mask_txt],
        ["项目范围", scope],
        ["日期范围", span],
        ["项目", f"{t['projects']} 行"],
        ["任务", f"{t['tasks']} 行"],
        ["工时记录", f"{t['work_logs']} 行"],
        ["合计工时", f"{mins} 分钟（{mins // 60}h{mins % 60:02d}m）"],
        ["日目标", f"{p['settings']['daily_target_min']} 分钟"],
        ["新一天起点", f"{p['settings']['day_start_hour']} 点"],
        ["关联方式", "表间用 id 关联：任务.项目 ID → 项目.项目 ID；"
                     "工时记录.任务 ID → 任务.任务 ID"],
        ["筛选口径", "日期范围只筛工时记录；任务和项目作为上下文全量保留，"
                     "方便按项目/任务汇总"],
        ["孤儿记录", "已删除项目或任务留下的工时记录保留，其项目 ID / 任务 ID "
                     "在对应表里找不到行，代表那件事已经被删了，工时仍然算数"],
        ["文本说明", "所有文本都以文本形式写入（inlineStr），开头是 = + - @ 也不会被当成公式"],
    ]
    if p["mask"] != "none":
        # 换筛选范围再导一份时，「项目 3」不一定是同一个项目——这句必须写在最显眼的地方
        rows.append(["脱敏编号怎么读",
                     "「项目 N / 任务 N」按本次导出的顺序编号，换筛选范围会重新编；"
                     "要跨文件对比，请按「项目 ID / 任务 ID」对齐，别看名字里的号"])
    return rows


def export_xlsx(payload) -> bytes:
    """把 payload 拼成一个真正的 .xlsx（OOXML 包），整包在内存里生成。"""
    about = xlsx_about_rows(payload)
    sheets = [
        ("说明", about[0], about[1:]),
        ("项目", ["项目 ID", "项目名", "颜色", "截止日期", "创建时间",
                  "仅工作日", "不计工时", "排序"],
         [[p["id"], p["name"], p["color"], p["deadline"], p["created_at"],
           p["workdays_only"], p["no_track"], p["sort_order"]]
          for p in payload["projects"]]),
        ("任务", ["任务 ID", "项目 ID", "任务名", "详情", "预估分钟", "已完成", "完成时间",
                  "创建时间", "截止日期", "排期日期", "日常", "仅工作日", "当天",
                  "提前量", "优先级", "标签", "重复类型", "重复星期", "重复月日",
                  "重复序数", "跳节假日", "重复间隔", "挂起", "挂起时间", "由上一件生成"],
         [[k["id"], k["project_id"], k["title"], k["detail"], k["estimate_min"], k["done"],
           k["done_at"], k["created_at"], k["due_date"], k["scheduled_date"],
           k["routine"], k["workday_only"], k["same_day"], k["lead_days"],
           k["priority"], k["tags"], k["repeat_type"], k["repeat_weekday"],
           k["repeat_monthday"], k["repeat_ordinal"], k["skip_holiday"],
           k["repeat_interval"], k["suspended"], k["suspended_at"], k["gen_from"]]
          for k in payload["tasks"]]),
        ("工时记录", ["工时 ID", "项目 ID", "任务 ID", "日期", "分钟", "开始时间",
                      "结束时间", "备注", "任务名（记录时的名字）"],
         [[w["id"], w["project_id"], w["task_id"], w["date"], w["minutes"],
           w["start_at"], w["end_at"], w["note"], w["task_name"]]
          for w in payload["work_logs"]]),
    ]
    overrides, rels = [], []
    for i, (name, _h, _r) in enumerate(sheets, 1):
        overrides.append(
            f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType='
            '"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        rels.append(
            f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/'
            'officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{i}.xml"/>')
    rels.append(f'<Relationship Id="rId{len(sheets) + 1}" Type="http://schemas.'
                'openxmlformats.org/officeDocument/2006/relationships/styles" '
                'Target="styles.xml"/>')
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/'
                'relationships"><sheets>' + "".join(
                    f'<sheet name="{xml_escape(name)}" sheetId="{i}" r:id="rId{i}"/>'
                    for i, (name, _h, _r) in enumerate(sheets, 1)) +
                "</sheets></workbook>")
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
               '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
               'relationships">' + "".join(rels) + "</Relationships>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _XLSX_CT % "".join(overrides))
        z.writestr("_rels/.rels", _XLSX_ROOT_RELS)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/styles.xml", _XLSX_STYLES)
        for i, (_name, header, rows) in enumerate(sheets, 1):
            z.writestr(f"xl/worksheets/sheet{i}.xml", xlsx_sheet_xml(header, rows))
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        # 跳转页（HTTPS）探测局域网 pace（HTTP）要走 Chrome 私有网络访问（PNA）：
        # 预检里声明允许私网目标，响应里放通来源。只读探测用，pace 本来就无凭据可偷
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # PNA / CORS 预检：放行来自 https 跳转页的探测请求
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_file(self, data: bytes, ctype: str, filename: str):
        """文件回包：整份在内存里写完再发出去，不落临时文件。"""
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:  # 含 JSONDecodeError / UnicodeDecodeError
            raise ValueError("请求格式不对：请求体不是合法 JSON")

    def do_GET(self):
        # 整条 GET 链路兜底：不兜的话任何一处异常都会让连接直接断掉，
        # 前端只能拿到一个空的响应体（报英文的 JSON 解析错误），两头都不好查
        try:
            backup_ensure_daily()   # 每天第一次请求顺手备份一次
            self._do_get()
        except ValueError as e:
            self._safe_error(str(e), 400)
        except Exception as e:
            self._safe_error(f"服务器错误: {e}", 500)

    def _safe_error(self, msg, code):
        """兜底回包：响应可能已经发出去一半了，再发失败也不能把异常抛回 serve 循环。"""
        try:
            self._json({"error": msg}, code)
        except Exception:
            pass

    def _do_get(self):
        if self.path == "/api/state":
            self._json(build_state())
            return
        if self.path == "/api/backups":
            items = []
            for path in reversed(list_backups()):
                try:
                    stat = path.stat()
                    item = {"file": path.name, "size": stat.st_size,
                            "at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                            "important": is_important_backup(path)}
                    err = _validate_db_file(path)
                    if err:
                        item["error"] = err
                    else:
                        conn = sqlite3.connect(path)
                        try:
                            item["counts"] = {
                                "projects": conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
                                "tasks": conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0],
                                "work_logs": conn.execute("SELECT COUNT(*) FROM work_logs").fetchone()[0],
                            }
                        finally:
                            conn.close()
                except Exception as e:
                    item = {"file": path.name, "error": f"读取备份失败：{e}",
                            "important": is_important_backup(path)}
                items.append(item)
            self._json({"items": items, "keep": BACKUP_KEEP,
                        "important_keep": BACKUP_IMPORTANT_KEEP})
            return
        if self.path == "/api/trash":
            conn = db()
            items = []
            for e in conn.execute("SELECT * FROM trash ORDER BY id DESC"):
                name, ntasks = trash_label(e)
                items.append({"id": e["id"], "kind": e["kind"], "name": name,
                              "tasks": ntasks, "deleted_at": e["deleted_at"]})
            conn.close()
            self._json({"items": items})
            return
        if self.path.startswith("/api/calendar"):
            from urllib.parse import urlparse, parse_qs
            from calendar import monthrange
            q = parse_qs(urlparse(self.path).query)
            ym = (q.get("month") or [""])[0]
            try:
                y, m = int(ym[:4]), int(ym[5:7])
                first = date(y, m, 1)
                last = date(y, m, monthrange(y, m)[1])
            except Exception:
                self._json({"error": "month 参数格式应为 YYYY-MM"}, 400)
                return
            conn = db()
            today = real_today()  # 日历投影的「今天」＝真实日期，与今日页排期同口径
            occ = []
            for t in conn.execute(f"""
                SELECT t.*, p.name AS pname, p.color AS pcolor
                FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
                WHERE t.done=0 AND {loop_sql()}
            """):
                for ds in project_task_dates(t, first, last, today):
                    occ.append({"date": ds, "title": t["title"], "project": t["pname"],
                                "color": t["pcolor"] or "#b8ad9a",
                                "routine": bool(t["routine"])})
            conn.close()
            self._json({"occ": occ})
            return
        if self.path.startswith("/api/stats/daily"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            rng = (q.get("range") or [""])[0].strip()
            if rng and rng not in ("month", "year"):
                # 先校验再开连接，避免参数错误时漏掉 conn.close()
                self._json({"error": "range 参数只支持 month 或 year"}, 400)
                return
            days = min(400, max(1, int((q.get("days") or ["14"])[0])))
            conn = db()
            h = day_start_hour(conn)
            today = logical_today(conn)
            if rng == "month":
                days = today.day                      # 当月 1 号 → 今天
            elif rng == "year":
                days = (today - date(today.year, 1, 1)).days + 1   # 今年 1 月 1 号 → 今天
            since = (today - timedelta(days=days - 1)).isoformat()
            rows = conn.execute("""
                SELECT w.date, w.project_id, SUM(w.minutes) m, p.name, p.color
                FROM work_logs w LEFT JOIN projects p ON p.id=w.project_id
                WHERE w.date>=? GROUP BY w.date, w.project_id ORDER BY w.date
            """, (since,)).fetchall()
            by_date = {}
            for r in rows:
                d = by_date.setdefault(r["date"], {"date": r["date"], "total": 0, "parts": [],
                                                   "logs": [], "done": []})
                d["parts"].append({"project_id": r["project_id"],
                                   "name": proj_name(r["project_id"], r["name"]),
                                   "color": proj_color(r["project_id"], r["color"]),
                                   "minutes": r["m"]})
                d["total"] += r["m"]
            # 每天的逐条工时记录（带任务名、预估和备注）
            for r in conn.execute("""
                SELECT w.id, w.date, w.minutes, w.note, w.project_id,
                       w.start_at, w.end_at,
                       COALESCE(t.title, w.task_name) AS task_title,
                       t.estimate_min AS task_est, t.routine AS task_routine,
                       t.repeat_type AS task_repeat,
                       p.name AS pname
                FROM work_logs w LEFT JOIN projects p ON p.id=w.project_id
                LEFT JOIN tasks t ON t.id=w.task_id
                WHERE w.date>=? ORDER BY w.date, w.id
            """, (since,)):
                by_date.setdefault(r["date"], {"date": r["date"], "total": 0, "parts": [],
                                               "logs": [], "done": []})
                by_date[r["date"]]["logs"].append({
                    "id": r["id"],
                    "task": r["task_title"],
                    "project": proj_name(r["project_id"], r["pname"]),
                    "estimate_min": r["task_est"],
                    "routine": 1 if (r["task_routine"] or r["task_repeat"]) else 0,
                    "start_at": r["start_at"], "end_at": r["end_at"],
                    "minutes": r["minutes"], "note": r["note"]})
            # 每天勾掉的任务：done_at 是真实时间戳，减掉起始小时数后归到所属逻辑日
            lo = logical_day_bounds(date.fromisoformat(since), h)[0]
            for r in conn.execute("""
                SELECT t.done_at, t.title, t.estimate_min, t.project_id,
                       t.routine, t.repeat_type,
                       p.name AS pname
                FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
                WHERE t.done=1 AND t.done_at>=? ORDER BY t.done_at
            """, (lo,)):
                ld = logical_date(r["done_at"], h)
                if ld is None:
                    continue
                ds = ld.isoformat()
                by_date.setdefault(ds, {"date": ds, "total": 0, "parts": [],
                                        "logs": [], "done": []})
                by_date[ds]["done"].append({"title": r["title"],
                                            "estimate_min": r["estimate_min"],
                                            "routine": 1 if (r["routine"] or r["repeat_type"]) else 0,
                                            "project": proj_name(r["project_id"], r["pname"])})
            days_list = []
            for i in range(days):
                ds = (today - timedelta(days=days - 1 - i)).isoformat()
                days_list.append(by_date.get(ds, {"date": ds, "total": 0, "parts": [],
                                                  "logs": [], "done": []}))
            wd_count = sum(
                1 for i in range(days)
                if is_workday(today - timedelta(days=days - 1 - i)))
            # 区间内每个 loop（日常/重复）任务按项目分组的耗时：同名实例合并，供逐 loop 统计
            loops = {}
            for r in conn.execute(f"""
                SELECT COALESCE(p.name, '未分配') AS pname, t.title, SUM(w.minutes) m
                FROM work_logs w JOIN tasks t ON t.id=w.task_id
                LEFT JOIN projects p ON p.id=w.project_id
                WHERE w.date>=? AND {loop_sql()}
                GROUP BY pname, t.title ORDER BY m DESC
            """, (since,)):
                loops.setdefault(r["pname"], []).append(
                    {"task": r["title"], "minutes": r["m"]})
            conn.close()
            self._json({"days": days_list, "workdays": wd_count, "loops": loops})
            return
        if self.path.startswith("/api/stats/loop-calib"):
            conn = db()
            h = day_start_hour(conn)
            today = logical_today(conn)
            items = loop_calib(conn, today, h)
            conn.close()
            self._json({"items": items, "min_n": CALIB_MIN_N, "min_est": CALIB_MIN_EST,
                        "window": CALIB_WINDOW, "warn_pct": int(CALIB_WARN_RATIO * 100)})
            return
        if self.path.startswith("/api/stats/tag-stats"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            rng = (q.get("range") or [""])[0].strip()
            if rng and rng not in ("month", "year"):
                # 先校验再开连接，跟 /api/stats/daily 一个规矩
                self._json({"error": "range 参数只支持 month 或 year"}, 400)
                return
            days = min(400, max(1, int((q.get("days") or ["14"])[0])))
            conn = db()
            h = day_start_hour(conn)
            today = logical_today(conn)
            if rng == "month":
                days = today.day
            elif rng == "year":
                days = (today - date(today.year, 1, 1)).days + 1
            since = today - timedelta(days=days - 1)
            items = tag_stats(conn, today, h, since)
            conn.close()
            self._json({"items": items, "days": days, "range": rng,
                        "since": since.isoformat()})
            return
        # ── 局域网同步端点（GET）───────────────────────────────────────────────
        if self.path == "/api/sync/info":
            self._json(sync_info())
            return
        if self.path.startswith("/api/sync/peer_info"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            peer = (q.get("peer") or [""])[0].strip()
            local = sync_info()
            if not peer:
                self._json({"local": local, "peer": None,
                            "error": "没有填对端地址"}, 400)
                return
            try:
                status, body = _http_request(peer, "/api/sync/info", timeout=8.0)
                if status != 200:
                    raise ValueError(f"HTTP {status}")
                peer_info = json.loads(body.decode("utf-8"))
                self._json({"local": local, "peer": peer_info})
            except Exception:
                self._json({"local": local, "peer": None,
                            "error": "对端连不上，或对方版本太旧没有同步功能"})
            return
        if self.path == "/api/sync/dump":
            tmp = _snapshot_to_temp()
            try:
                data = tmp.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            finally:
                try:
                    tmp.unlink()
                except OSError:
                    pass
            return
        if self.path.split("?")[0] == "/api/update/check":
            self._update_check()
            return
        # ── 本机也当更新源：/release/manifest.json + /release/<path> ─────────────
        if self.path == "/release/manifest.json":
            body = json.dumps(_release_manifest(), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/release/"):
            # 先 URL 解码再校验：客户端按 quote() 编码中文文件名
            # （使用说明.txt 等），不解码会查无此文件 404（v1.5.3 踩过）。
            # 解码后再过白名单，%2e%2e 这类编码越界一样会被拦
            rel = unquote(urlsplit(self.path).path[9:])  # 去掉 '/release/'
            # 和 apply 端同一套白名单；另外 data/pace.db 这类敏感路径本来就不在白名单
            if not _is_update_path_allowed(rel):
                self._json({"error": "路径不在允许列表内"}, 403)
                return
            src = (BASE / rel).resolve()
            # 二次保险：必须是 BASE 下的真实文件
            if not str(src).startswith(str(BASE.resolve())) or not src.is_file():
                self._json({"error": "文件不存在"}, 404)
                return
            data = src.read_bytes()
            ctype = {
                ".py": "text/plain",
                ".js": "text/javascript",
                ".css": "text/css",
                ".html": "text/html",
                ".json": "application/json",
                ".txt": "text/plain",
                ".bat": "text/plain",
                ".png": "image/png",
                ".svg": "image/svg+xml",
                ".ico": "image/x-icon",
                ".webmanifest": "application/manifest+json",
            }.get(src.suffix.lower(), "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        path = self.path.split("?")[0]
        if path == "/":
            path = "/index.html"
        f = (STATIC / path.lstrip("/")).resolve()
        if not str(f).startswith(str(STATIC.resolve())) or not f.is_file():
            self._json({"error": "not found"}, 404)
            return
        ctype = {".html": "text/html", ".js": "text/javascript",
                 ".css": "text/css", ".svg": "image/svg+xml",
                 ".png": "image/png", ".ico": "image/x-icon",
                 ".webmanifest": "application/manifest+json"}.get(f.suffix, "application/octet-stream")
        body = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")  # 小文件，每次都重新校验，防止升级后跑到旧前端
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parts = [p for p in self.path.split("/") if p]
        try:
            backup_ensure_daily()   # 每天第一次请求顺手备份一次
            # 同步端点先处理：receive 要读原始字节，不能走 _body() 的 JSON 解析
            if parts == ["api", "sync", "receive"]:
                self._sync_receive()
                return
            if parts == ["api", "sync", "pull"]:
                self._sync_pull()
                return
            if parts == ["api", "sync", "push"]:
                self._sync_push()
                return
            if parts == ["api", "update", "apply"]:
                self._update_apply()
                return
            body = self._body()
            if parts == ["api", "projects"]:
                self._create_project(body)
            elif parts == ["api", "projects", "reorder"]:
                self._reorder_projects(body)
            elif len(parts) == 3 and parts[:2] == ["api", "projects"]:
                self._update_project(int(parts[2]), body)
            elif len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "autoplan":
                self._autoplan(int(parts[2]))
            elif len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "delete":
                self._delete_project(int(parts[2]))
            elif parts == ["api", "tasks"]:
                self._create_task(body)
            elif len(parts) == 4 and parts[:2] == ["api", "tasks"] and parts[3] == "toggle":
                self._toggle_task(int(parts[2]))
            elif len(parts) == 4 and parts[:2] == ["api", "tasks"] and parts[3] == "delete":
                self._delete_task(int(parts[2]))
            elif len(parts) == 3 and parts[:2] == ["api", "tasks"]:
                self._update_task(int(parts[2]), body)
            elif parts == ["api", "timer", "start"]:
                self._timer_start(int(body.get("task_id") or 0))
            elif parts == ["api", "timer", "stop"]:
                self._timer_stop()
            elif parts == ["api", "timer", "finish"]:
                self._timer_finish()
            elif parts == ["api", "logs"]:
                self._manual_log(body)
            elif len(parts) == 4 and parts[:2] == ["api", "logs"] and parts[3] == "delete":
                self._delete_log(int(parts[2]))
            elif len(parts) == 3 and parts[:2] == ["api", "logs"]:
                self._update_log(int(parts[2]), body)
            elif parts == ["api", "trash", "empty"]:
                self._trash_empty()
            elif len(parts) == 4 and parts[:2] == ["api", "trash"] and parts[3] == "restore":
                self._trash_restore(int(parts[2]))
            elif len(parts) == 4 and parts[:2] == ["api", "trash"] and parts[3] == "purge":
                self._trash_purge(int(parts[2]))
            elif parts == ["api", "settings"]:
                self._update_settings(body)
            elif parts == ["api", "backup"]:
                self._backup_now()
            elif parts == ["api", "backup", "restore"]:
                self._backup_restore(body)
            elif parts == ["api", "export"]:
                self._export(body)
            elif parts == ["api", "shutdown"]:
                self._shutdown()
            elif parts == ["api", "restart"]:
                self._restart()
            else:
                self._json({"error": "not found"}, 404)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:
            self._json({"error": f"服务器错误: {e}"}, 500)

    def _create_project(self, body):
        name = (body.get("name") or "").strip()
        deadline = (body.get("deadline") or "").strip()
        if not name:
            raise ValueError("项目名称不能为空")
        if deadline:
            date.fromisoformat(deadline)
        conn = db()
        color = body.get("color") or PALETTE[conn.execute("SELECT COUNT(*) c FROM projects").fetchone()["c"] % len(PALETTE)]
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM projects").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO projects(name, color, deadline, created_at, sort_order) VALUES(?,?,?,?,?)",
            (name, color, deadline or None, datetime.now().isoformat(timespec="seconds"), max_order + 1))
        conn.commit()
        self._json({"id": cur.lastrowid})

    def _reorder_projects(self, body):
        ids = body.get("ids")
        if not isinstance(ids, list) or not ids:
            raise ValueError("ids 应为非空数组")
        conn = db()
        existing = {r["id"] for r in conn.execute("SELECT id FROM projects")}
        if not set(ids).issubset(existing):
            raise ValueError("存在无效项目 id")
        for order, pid in enumerate(ids, start=1):
            conn.execute("UPDATE projects SET sort_order=? WHERE id=?", (order, pid))
        conn.commit()
        self._json({"ok": True})

    def _update_project(self, project_id, body):
        conn = db()
        if not conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise ValueError("项目不存在")
        fields, vals = [], []
        if "name" in body:
            name = (body["name"] or "").strip()
            if not name:
                raise ValueError("项目名称不能为空")
            fields.append("name=?"); vals.append(name)
        if "deadline" in body:
            dl = (body["deadline"] or "").strip() or None
            if dl:
                date.fromisoformat(dl)
            fields.append("deadline=?"); vals.append(dl)
        if "color" in body and body["color"]:
            fields.append("color=?"); vals.append(body["color"])
        if "no_track" in body:
            fields.append("no_track=?"); vals.append(1 if body["no_track"] else 0)
        if "workdays_only" in body:
            fields.append("workdays_only=?"); vals.append(1 if body["workdays_only"] else 0)
        if not fields:
            raise ValueError("没有要修改的字段")
        vals.append(project_id)
        conn.execute(f"UPDATE projects SET {', '.join(fields)} WHERE id=?", vals)
        conn.commit()
        self._json({"ok": True})

    def _update_settings(self, body):
        if "daily_target_min" in body:
            v = int(body["daily_target_min"])
            if v <= 0:
                raise ValueError("每日目标必须大于 0")
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('daily_target_min', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(v),))
            conn.commit()
        if "day_start_hour" in body:
            v = int(body["day_start_hour"])
            if not 0 <= v <= 23:
                raise ValueError("新一天的起始小时必须填 0-23")
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('day_start_hour', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(v),))
            conn.commit()
        if "sync_peer" in body:
            v = str(body.get("sync_peer") or "").strip()
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('sync_peer', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (v,))
            conn.commit()
        if "sync_device" in body:
            v = str(body.get("sync_device") or "").strip()
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('sync_device', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (v,))
            conn.commit()
        if "update_enabled" in body:
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('update_enabled', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ("1" if body["update_enabled"] else "0",))
            conn.commit()
        if "update_url" in body:
            v = str(body.get("update_url") or "").strip()
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('update_url', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (v,))
            conn.commit()
        if "pace_go_url" in body:
            v = str(body.get("pace_go_url") or "").strip()
            if len(v) > 500:
                raise ValueError("跳转页地址最长 500 个字符")
            if v:
                try:
                    parsed = urlsplit(v)
                    valid = (parsed.scheme.lower() in ("http", "https")
                             and bool(parsed.netloc) and bool(parsed.hostname)
                             and not any(ch.isspace() for ch in v))
                except ValueError:
                    valid = False
                if not valid:
                    raise ValueError("跳转页地址要填完整的 http:// 或 https:// 地址，且不能包含空格；留空则恢复默认")
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('pace_go_url', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (v,))
            conn.commit()
        if "show_project_prefix" in body:
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('show_project_prefix', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ("1" if body["show_project_prefix"] else "0",))
            conn.commit()
        if "autostart" in body:
            set_autostart(bool(body["autostart"]))
        if "lan_access" in body:
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('lan_access', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ("1" if body["lan_access"] else "0",))
            conn.commit()
        if "show_dual_track" in body:
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('show_dual_track', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ("1" if body["show_dual_track"] else "0",))
            conn.commit()
        if "next_suggest_count" in body:
            try:
                v = int(body["next_suggest_count"])
            except (TypeError, ValueError):
                raise ValueError("下一件推荐必须是 1-5 的整数")
            if not 1 <= v <= 5:
                raise ValueError("下一件推荐必须是 1-5 的整数")
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('next_suggest_count', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(v),))
            conn.commit()
        if "dynamic_routine_settlement" in body:
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('dynamic_routine_settlement', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ("1" if body["dynamic_routine_settlement"] else "0",))
            conn.commit()
        if "recommend_min_minutes" in body:
            # 0 = 不分档（全部留在主建议里）；上限 480 是「一天的量」，再多就失去分档意义
            try:
                v = int(body["recommend_min_minutes"])
            except (TypeError, ValueError):
                raise ValueError("小额阈值必须是 0-480 的整数（0 = 不分档）")
            if not 0 <= v <= 480:
                raise ValueError("小额阈值必须是 0-480 的整数（0 = 不分档）")
            conn = db()
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('recommend_min_minutes', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(v),))
            conn.commit()
        if "recommend_project_ids" in body:
            # 存成 JSON 数组，顺序就是优先级。不存在的项目直接 400 拒绝（不静默吞掉：
            # 吞掉会让用户以为排好了，实际顺序不对）；重复 id 去重保留第一次出现的位置
            raw = body["recommend_project_ids"]
            if raw is None:
                raw = []
            if not isinstance(raw, list):
                raise ValueError("优先项目要传项目 id 数组")
            ids = []
            for v in raw:
                try:
                    n = int(v)
                except (TypeError, ValueError):
                    raise ValueError("优先项目里有不是数字的项目 id")
                if n not in ids:
                    ids.append(n)
            conn = db()
            if ids:
                marks = ",".join("?" * len(ids))
                have = {r["id"] for r in conn.execute(
                    f"SELECT id FROM projects WHERE id IN ({marks})", ids)}
                missing = [i for i in ids if i not in have]
                if missing:
                    raise ValueError("优先项目里有不存在的项目：" +
                                     "、".join(str(i) for i in missing))
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('recommend_project_ids', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (json.dumps(ids),))
            conn.commit()
        self._json({"ok": True})

    def _shutdown(self):
        """前端「关闭服务」按钮：先回包再关，shutdown() 会让 serve_forever 退出。"""
        self._json({"ok": True})
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def _restart(self):
        """一键重启：先把「已受理」回给浏览器，再起辅助进程，最后关掉自己。

        顺序不能反：先关再起，端口会空一段时间，浏览器只会看到连接失败；
        辅助进程从发起那一刻就在等端口，等旧进程真的让出来才 bind，所以不会出现
        「旧进程还占着端口就硬起新进程」（那样新进程会直接 bind 失败退出）。
        """
        try:
            helper = spawn_restart_helper()
        except Exception as e:
            self._json({"error": f"重启失败：起不了辅助进程（{e}）"}, 500)
            return
        self._json({"ok": True, "pid": os.getpid(), "helper": helper, "port": PORT})
        threading.Thread(target=self._restart_later, daemon=True).start()

    def _restart_later(self):
        # 回包要先发出去：立刻 shutdown 会让浏览器读到半截响应，前端就拿不到 ok 了
        time.sleep(0.4)
        self.server.shutdown()

    # ── 局域网同步 POST 处理 ────────────────────────────────────────────────

    def _sync_receive(self):
        """接收对端传来的整库字节，校验通过后热替换本机 DB。"""
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            self._json({"error": "请求体为空"}, 400)
            return
        raw = self.rfile.read(n)
        tmp = DB.parent / "sync-incoming.tmp"
        with SYNC_LOCK:
            try:
                tmp.write_bytes(raw)
                err = _validate_db_file(tmp)
                if err:
                    self._json({"error": err}, 400)
                    return
                backup_name = _replace_with_db(tmp)
                self._json({"ok": True, "backup": backup_name})
            finally:
                # 校验失败或已替换后，临时文件都没必要留着
                if tmp.exists():
                    try:
                        tmp.unlink()
                    except OSError:
                        pass

    def _sync_pull(self):
        """本机当客户端，从对端拉取较新的数据库并覆盖本机。"""
        body = self._body()
        peer = (body.get("peer") or "").strip()
        force = bool(body.get("force"))
        if not peer:
            self._json({"error": "没有填对端地址"}, 400)
            return
        try:
            status, info_body = _http_request(peer, "/api/sync/info", timeout=8.0)
            if status != 200:
                raise ValueError(f"HTTP {status}")
            peer_info = json.loads(info_body.decode("utf-8"))
        except Exception:
            self._json({"error": "对端连不上"}, 502)
            return
        local_info = sync_info()
        if peer_info.get("db_mtime", 0) <= local_info["db_mtime"] and not force:
            self._json({"conflict": True, "local": local_info, "peer": peer_info})
            return
        try:
            status, dump = _http_request(peer, "/api/sync/dump", timeout=30.0)
            if status != 200:
                raise ValueError(f"下载对端数据库失败：HTTP {status}")
        except Exception as e:
            self._json({"error": f"下载对端数据库失败：{e}"}, 502)
            return
        tmp = DB.parent / "sync-incoming.tmp"
        with SYNC_LOCK:
            try:
                tmp.write_bytes(dump)
                err = _validate_db_file(tmp)
                if err:
                    self._json({"error": err}, 400)
                    return
                backup_name = _replace_with_db(tmp)
                self._json({"ok": True, "backup": backup_name})
            finally:
                if tmp.exists():
                    try:
                        tmp.unlink()
                    except OSError:
                        pass

    def _sync_push(self):
        """本机当客户端，把本机数据库推送到对端。"""
        body = self._body()
        peer = (body.get("peer") or "").strip()
        force = bool(body.get("force"))
        if not peer:
            self._json({"error": "没有填对端地址"}, 400)
            return
        try:
            status, info_body = _http_request(peer, "/api/sync/info", timeout=8.0)
            if status != 200:
                raise ValueError(f"HTTP {status}")
            peer_info = json.loads(info_body.decode("utf-8"))
        except Exception:
            self._json({"error": "对端连不上"}, 502)
            return
        local_info = sync_info()
        if peer_info.get("db_mtime", 0) >= local_info["db_mtime"] and not force:
            self._json({"conflict": True, "local": local_info, "peer": peer_info})
            return
        tmp = _snapshot_to_temp()
        try:
            data = tmp.read_bytes()
            status, resp_body = _http_request(
                peer, "/api/sync/receive", method="POST", data=data,
                timeout=30.0, headers={"Content-Type": "application/octet-stream"})
            try:
                resp = json.loads(resp_body.decode("utf-8")) if resp_body else {}
            except Exception:
                resp = {"raw": resp_body.decode("utf-8", errors="replace")}
            if status != 200:
                msg = resp.get("error") or f"对端拒绝接收：HTTP {status}"
                self._json({"error": msg}, 502)
                return
            self._json(resp)
        finally:
            try:
                tmp.unlink()
            except OSError:
                pass

    def _update_check(self):
        """检查更新源，返回当前版本、远程版本、差异文件列表。

        优先用 query 参数 base；没有就用 settings.update_url；再没有就用 UPDATE_BASE。
        """
        from urllib.parse import urlparse, parse_qs
        dev = is_dev_machine()
        q = parse_qs(urlparse(self.path).query)
        base = (q.get("base") or [""])[0].strip() or update_url()
        try:
            manifest = _fetch_manifest(base, timeout=10.0)
        except ValueError as e:
            self._json({"enabled": update_enabled(), "current": VERSION,
                        "remote": None, "changes": [], "dev": dev,
                        "error": str(e)})
            return
        remote_ver = manifest.get("version", "")
        files = manifest.get("files", {})
        changes = []
        for rel, remote_hash in files.items():
            if not _is_update_path_allowed(rel):
                continue
            local = BASE / rel
            if not local.is_file():
                changes.append({"path": rel, "reason": "新增"})
            elif _sha256_file(local) != remote_hash:
                changes.append({"path": rel, "reason": "有更新"})
        self._json({"enabled": update_enabled(), "current": VERSION,
                    "remote": remote_ver, "changes": changes, "dev": dev,
                    "base": base})

    def _update_apply(self):
        """下载并应用更新包：校验→下载→备份→替换。

        body 里可传 base 临时指定更新源；不传则按 settings.update_url / UPDATE_BASE。
        """
        if is_dev_machine():
            self._json({"error": "这台是开发机，禁止自动更新"}, 403)
            return
        if not update_enabled():
            self._json({"error": "自动更新未开启，先在设置里打开"}, 403)
            return
        body = self._body()
        base = (body.get("base") or "").strip() or update_url()
        try:
            manifest = _fetch_manifest(base, timeout=10.0)
        except ValueError as e:
            self._json({"error": str(e)}, 502)
            return
        remote_ver = manifest.get("version", "")
        if not remote_ver:
            self._json({"error": "更新源清单缺少版本号"}, 502)
            return
        files = manifest.get("files", {})
        if not isinstance(files, dict) or not files:
            self._json({"error": "更新源清单没有文件列表"}, 502)
            return
        # 白名单校验：只要有一条非法，整体拒绝
        for rel in files:
            if not _is_update_path_allowed(rel):
                self._json({"error": f"更新包包含非法路径：{rel}"}, 400)
                return
        # 先算本地变化，没变化就不用下
        changes = []
        for rel, remote_hash in files.items():
            local = BASE / rel
            if not local.is_file() or _sha256_file(local) != remote_hash:
                changes.append(rel)
        if not changes:
            self._json({"ok": True, "updated": [], "backup": None,
                        "need_restart": False})
            return

        tmp_dir = BASE / "data" / "update-tmp"
        backup_dir = BASE / "data" / "backup" / \
            datetime.now().strftime("update-%Y%m%d-%H%M%S")
        try:
            # 清理/创建临时目录
            if tmp_dir.exists():
                shutil.rmtree(tmp_dir)
            tmp_dir.mkdir(parents=True, exist_ok=True)
            backup_dir.mkdir(parents=True, exist_ok=True)

            downloaded = []
            from urllib.parse import quote
            for rel in changes:
                url = base.rstrip("/") + "/" + quote(rel.replace("\\", "/"))
                try:
                    with urllib.request.urlopen(url, timeout=30.0) as resp:
                        data = resp.read()
                except Exception as e:
                    raise ValueError(f"下载 {rel} 失败：{e}")
                expected = files[rel]
                actual = hashlib.sha256(data).hexdigest()
                if actual != expected:
                    raise ValueError(f"{rel} 校验失败（sha256 不符）")
                # app.py 额外校验
                if rel == "app.py":
                    err = _compile_app_py(data)
                    if err:
                        raise ValueError(err)
                    err = _check_app_version(data, remote_ver)
                    if err:
                        raise ValueError(err)
                out = tmp_dir / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(data)
                downloaded.append(rel)

            # 备份将被覆盖的旧文件（保持目录结构）
            for rel in downloaded:
                local = BASE / rel
                if local.is_file():
                    bk = backup_dir / rel
                    bk.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(local, bk)

            # 原子替换：先 static/.bat/.txt，最后 app.py
            app_py_tmp = None
            for rel in downloaded:
                if rel == "app.py":
                    app_py_tmp = tmp_dir / rel
                    continue
                dst = BASE / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                _replace_file_atomic(tmp_dir / rel, dst)
            if app_py_tmp:
                _replace_file_atomic(app_py_tmp, BASE / "app.py")

            updated = downloaded
            need_restart = "app.py" in updated
            self._json({"ok": True, "updated": updated,
                        "backup": backup_dir.name,
                        "need_restart": need_restart})
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except Exception as e:
            self._json({"error": f"更新失败：{e}"}, 500)
        finally:
            if tmp_dir.exists():
                try:
                    shutil.rmtree(tmp_dir)
                except Exception:
                    pass

    def _backup_now(self):
        """设置页「立即备份」：手动补一份，把文件名回给前端好让用户拷走。"""
        try:
            path = make_backup("手动")
        except Exception as e:
            global _backup_error
            _backup_error = str(e)
            print(f"手动备份失败：{e}", file=sys.stderr)
            self._json({"error": f"备份失败：{e}"}, 500)
            return
        self._json({"ok": True, "file": path.name, "dir": str(backup_dir()),
                    "keep": BACKUP_KEEP, "count": len(list_backups())})

    def _backup_restore(self, body):
        """从选定备份恢复整库；原备份不动，覆盖当前库前另留重要回滚点。"""
        tmp = DB.parent / "restore-incoming.tmp"
        with SYNC_LOCK:
            try:
                src = backup_file(body.get("file"))
                # 先复制再校验，绝不能把备份原件 move 走。
                shutil.copyfile(src, tmp)
                err = _validate_db_file(tmp)
                if err:
                    self._json({"error": err}, 400)
                    return
                backup_name = _replace_with_db(tmp, "恢复覆盖前", protect=src)
                self._json({"ok": True, "file": src.name, "backup": backup_name})
            finally:
                if tmp.exists():
                    try:
                        tmp.unlink()
                    except OSError:
                        pass

    def _export(self, body):
        """历史数据导出：JSON 或 XLSX，整份从内存回给浏览器。全程只读，不改库。"""
        f = export_parse_args(body)
        conn = db()
        try:
            payload = export_payload(conn, f, export_collect(conn, f))
        finally:
            conn.close()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        if f["format"] == "xlsx":
            self._send_file(
                export_xlsx(payload),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                f"pace-export-{stamp}.xlsx")
        else:
            self._send_file(
                json.dumps(payload, ensure_ascii=False, indent=1).encode("utf-8"),
                "application/json; charset=utf-8",
                f"pace-export-{stamp}.json")

    def _autoplan(self, project_id):
        """把未排期的普通任务按安全线容量，从今天到 deadline 贪心分摊到每天。"""
        conn = db()
        p = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not p:
            raise ValueError("项目不存在")
        if not p["deadline"]:
            raise ValueError("这个项目没有 deadline，无法自动排期")
        # 自动排期是排期语义：从真实今天（0 点翻页）排起，跟今日页看到的一致
        today = real_today()
        dl = date.fromisoformat(p["deadline"])
        days_left = (dl - today).days
        if days_left < 0:
            raise ValueError("deadline 已过，先把项目日期改到未来")
        horizon = [(today + timedelta(days=i)).isoformat() for i in range(effective_days(days_left))]

        loads = {d: 0 for d in horizon}
        # 挂起的不占容量：它这几周都不该排，算进已排量会让别人的份额被挤小
        for t in conn.execute(
            "SELECT scheduled_date, estimate_min FROM tasks WHERE project_id=? AND done=0 "
            "AND scheduled_date IS NOT NULL AND COALESCE(suspended,0)=0",
            (project_id,)):
            if t["scheduled_date"] in loads:
                loads[t["scheduled_date"]] += est_min(t)
        # 有提前量的任务不参与自动排期（same_day = 提前 0 天）：它只该待在
        # 自己的窗口里，排进来还会把别人的容量份额撑大
        todo = conn.execute("""
            SELECT * FROM tasks WHERE project_id=? AND done=0 AND routine=0 AND scheduled_date IS NULL
            AND COALESCE(same_day,0)=0 AND lead_days IS NULL AND COALESCE(suspended,0)=0
            ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date, id
        """, (project_id,)).fetchall()
        if not todo:
            raise ValueError("没有待排期的任务")

        remaining_all = sum(est_min(t) for t in conn.execute(
            "SELECT estimate_min FROM tasks WHERE project_id=? AND done=0 AND routine=0 "
            "AND COALESCE(same_day,0)=0 AND lead_days IS NULL AND COALESCE(suspended,0)=0",
            (project_id,)))
        cap = math.ceil(remaining_all / len(horizon))

        start = 0
        unplaced = 0
        for t in todo:
            placed = False
            for i in range(start, len(horizon)):
                ds = horizon[i]
                if t["due_date"] and ds > t["due_date"]:
                    break  # 不排在它自己的 due 之后
                base = loads[ds]
                est = est_min(t)
                if base == 0 or base + est <= cap:
                    conn.execute("UPDATE tasks SET scheduled_date=? WHERE id=?", (ds, t["id"]))
                    loads[ds] = base + est
                    # 无预估任务不占容量：不因为它在某天就让那天「排满」而跳过去
                    if est and loads[ds] >= cap:
                        start = i + 1
                    placed = True
                    break
            if not placed:
                unplaced += 1
        conn.commit()
        self._json({"placed": len(todo) - unplaced, "unplaced": unplaced, "cap_min": cap})

    def _create_task(self, body):
        title = (body.get("title") or "").strip()
        if not title:
            raise ValueError("任务标题不能为空")
        # 没传 estimate_min 就按 45 分钟；显式传 null/空 = 暂无预估（存 NULL，不占安全线）
        est = DEFAULT_ESTIMATE if "estimate_min" not in body else _norm_estimate(body["estimate_min"])
        conn = db()
        if not conn.execute("SELECT 1 FROM projects WHERE id=?", (body.get("project_id"),)).fetchone():
            raise ValueError("项目不存在")
        rt = body.get("repeat_type") or None
        if rt not in (None, "daily", "weekly", "monthly", "monthly_week",
                      "interval_weekly", "monthly_workday"):
            raise ValueError("未知重复类型")
        weekdays = monthdays = ordinal = interval = None
        if rt == "weekly":
            weekdays = _norm_day_list(body.get("repeat_weekdays", body.get("repeat_weekday")), 0, 6)
        elif rt == "interval_weekly":
            weekdays = _norm_day_list(body.get("repeat_weekdays", body.get("repeat_weekday")), 0, 6)
            if not weekdays:
                raise ValueError("请选择周几")
            interval = int(body.get("repeat_interval") or 2)
            if not 1 <= interval <= 52:
                raise ValueError("间隔周数无效（1-52）")
        elif rt == "monthly":
            monthdays = _norm_day_list(body.get("repeat_monthdays", body.get("repeat_monthday")), 1, 31)
        elif rt == "monthly_week":
            wd = body.get("repeat_weekday")
            if wd is None or not 0 <= int(wd) <= 6:
                raise ValueError("请选择周几")
            weekdays = str(int(wd))
            ordinal = int(body.get("repeat_ordinal") or 1)
            if ordinal not in (1, 2, 3, 4, -1):
                raise ValueError("第几个周几无效")
        elif rt == "monthly_workday":
            ordinal = int(body.get("repeat_ordinal") or 1)
            if ordinal not in (1, 2, 3, 4, 5, -1):
                raise ValueError("第几个工作日无效")
        prio = int(body.get("priority") or 0)
        if prio not in (0, 1, 3, 5):
            raise ValueError("优先级无效")
        due = _valid_date(body.get("due_date"))
        # 有 due 就自动排到 due 那天
        scheduled = _valid_date(body.get("scheduled_date")) or due
        # 提前量与 same_day 是同一件事的两种写法：body 里给了 lead_days 就以它为准
        lead = _norm_lead(body.get("lead_days"))
        same = (1 if lead == 0 else 0) if "lead_days" in body \
            else (1 if body.get("same_day") else 0)
        cur = conn.execute(
            "INSERT INTO tasks(project_id, title, detail, estimate_min, routine, workday_only, created_at, "
            "due_date, "
            "scheduled_date, repeat_type, repeat_weekday, repeat_monthday, repeat_ordinal, skip_holiday, priority, "
            "same_day, lead_days, tags, repeat_interval) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (body["project_id"], title, _norm_detail(body.get("detail")),
             est, 1 if (body.get("routine") or body.get("workday_only")) else 0,
             1 if body.get("workday_only") else 0,
             datetime.now().isoformat(timespec="seconds"), due, scheduled,
             rt, weekdays, monthdays, ordinal,
             1 if body.get("skip_holiday") else 0, prio,
             same, lead, _norm_tags(body.get("tags")), interval))
        conn.commit()
        self._json({"id": cur.lastrowid})

    def _update_task(self, task_id, body):
        conn = db()
        old = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not old:
            raise ValueError("任务不存在")
        fields, vals = [], []
        if "title" in body:
            title = (body["title"] or "").strip()
            if not title:
                raise ValueError("任务标题不能为空")
            fields.append("title=?"); vals.append(title)
        if "detail" in body:
            # 传空串 = 清空详情（跟 work_logs.note 一样：note 记这一次干了什么，
            # detail 是这件事本身长期有效的说明，两者互不覆盖）
            fields.append("detail=?"); vals.append(_norm_detail(body["detail"]))
        if "estimate_min" in body:
            fields.append("estimate_min=?"); vals.append(_norm_estimate(body["estimate_min"]))
        if "routine" in body:
            fields.append("routine=?"); vals.append(1 if body["routine"] else 0)
        if "workday_only" in body:
            fields.append("workday_only=?"); vals.append(1 if body["workday_only"] else 0)
            if body["workday_only"]:
                # workday_only=1 必然是日常：没带 routine 就补上，带了就强制为 1
                if "routine=?" in fields:
                    vals[fields.index("routine=?")] = 1
                else:
                    fields.append("routine=?"); vals.append(1)
        if "same_day" in body:
            fields.append("same_day=?"); vals.append(1 if body["same_day"] else 0)
        if "lead_days" in body:
            # lead_days 与 same_day 说的是同一件事（0 天 = 仅当天），
            # 同一个请求里同时给了就以 lead_days 为准，别让两者打架
            lead = _norm_lead(body["lead_days"])
            fields.append("lead_days=?"); vals.append(lead)
            same = 1 if lead == 0 else 0
            if "same_day=?" in fields:
                vals[fields.index("same_day=?")] = same
            else:
                fields.append("same_day=?"); vals.append(same)
        if "project_id" in body:
            pid = body["project_id"]
            if pid in (None, ""):
                fields.append("project_id=?"); vals.append(None)
            else:
                if not conn.execute("SELECT 1 FROM projects WHERE id=?", (int(pid),)).fetchone():
                    raise ValueError("项目不存在")
                fields.append("project_id=?"); vals.append(int(pid))
        if "priority" in body:
            prio = int(body["priority"] or 0)
            if prio not in (0, 1, 3, 5):
                raise ValueError("优先级无效")
            fields.append("priority=?"); vals.append(prio)
        if "tags" in body:
            # 传空串 = 清空标签；归一化跟新建同一套（转小写、逗号连起来）
            fields.append("tags=?"); vals.append(_norm_tags(body["tags"]))
        suspend_clear = False
        if "suspended" in body:
            # 挂起 = 等回复/暂时推不动的事先移出台面。挂起期间 due / 排期一并失效清空：
            # 搁置的事本来就没法按日子催，留着只会刷出没意义的「逾期」；恢复后重新设置
            want = 1 if body["suspended"] else 0
            # 日常和重复任务会自动长下一件：挂起它们等于把一整类事悄悄关掉，
            # 过期也不会有人提醒，所以只给一次性任务用。恢复不设限（历史数据兜底）
            if want and is_loop(old):
                raise ValueError("日常/重复任务不能挂起（会自动长下一件，挂起等于把它关掉），只给一次性任务用")
            fields.append("suspended=?"); vals.append(want)
            # 挂起时刻记真实日：这是个「挂了几天没跟进」的催办计数，按自然日算才符合直觉，
            # 跟前端算逾期用的 state.today 同一个口径。只在 0→1 这次写，已挂起再点一次不重置天数
            if want:
                if not old["suspended"]:
                    fields.append("suspended_at=?"); vals.append(real_today().isoformat())
                suspend_clear = True
            else:
                fields.append("suspended_at=?"); vals.append(None)
        if "repeat_type" in body:
            rt = body["repeat_type"] or None
            if rt not in (None, "daily", "weekly", "monthly", "monthly_week",
                          "interval_weekly", "monthly_workday"):
                raise ValueError("未知重复类型")
            fields.append("repeat_type=?"); vals.append(rt)
            fields.append("repeat_weekday=?")
            fields.append("repeat_monthday=?")
            fields.append("repeat_ordinal=?")
            fields.append("repeat_interval=?")
            if rt == "weekly":
                vals.append(_norm_day_list(body.get("repeat_weekdays", body.get("repeat_weekday")), 0, 6))
                vals.extend([None, None, None])
            elif rt == "interval_weekly":
                wds = _norm_day_list(body.get("repeat_weekdays", body.get("repeat_weekday")), 0, 6)
                if not wds:
                    raise ValueError("请选择周几")
                vals.append(wds)
                vals.append(None)
                vals.append(None)
                interval = int(body.get("repeat_interval") or 2)
                if not 1 <= interval <= 52:
                    raise ValueError("间隔周数无效（1-52）")
                vals.append(interval)
            elif rt == "monthly":
                vals.append(None)
                vals.append(_norm_day_list(body.get("repeat_monthdays", body.get("repeat_monthday")), 1, 31))
                vals.extend([None, None])
            elif rt == "monthly_week":
                wd = body.get("repeat_weekday")
                if wd is None or not 0 <= int(wd) <= 6:
                    raise ValueError("请选择周几")
                vals.append(str(int(wd)))
                vals.append(None)
                ordinal = int(body.get("repeat_ordinal") or 1)
                if ordinal not in (1, 2, 3, 4, -1):
                    raise ValueError("第几个周几无效")
                vals.append(ordinal)
                vals.append(None)
            elif rt == "monthly_workday":
                vals.extend([None, None])
                ordinal = int(body.get("repeat_ordinal") or 1)
                if ordinal not in (1, 2, 3, 4, 5, -1):
                    raise ValueError("第几个工作日无效")
                vals.append(ordinal)
                vals.append(None)
            else:
                vals.extend([None, None, None, None])
            fields.append("skip_holiday=?")
            vals.append(1 if body.get("skip_holiday") else 0)
        for col in ("due_date", "scheduled_date"):
            if col in body:
                fields.append(f"{col}=?"); vals.append(_valid_date(body[col]))
        # 挂起生效的同时让 due / 排期失效：搁置的事没法按日子催，留着只会刷「逾期」。
        # 同一个请求里显式给了新日期的，以新值为准（恢复后改走正常改期逻辑）
        if suspend_clear:
            if "due_date" not in body:
                fields.append("due_date=?"); vals.append(None)
            if "scheduled_date" not in body:
                fields.append("scheduled_date=?"); vals.append(None)
        # 主动清空排期 = 放回池子，打标记防止自动排期又钉回去；
        # 手动排期或改 due 则解除标记
        if body.get("scheduled_date") == "":
            fields.append("no_autosched=?"); vals.append(1)
        elif body.get("scheduled_date") or body.get("due_date"):
            fields.append("no_autosched=?"); vals.append(0)
        # 改了 due（值真的变了才算）：只要不是主动放回池子的，排期跟着搬到新 due。
        # 旧口径只认「旧排期恰好等于旧 due」，被自动排期或手动挪过的任务会钉死在原日期，
        # 今日页上改了 due 事还赖在今天；编辑表单每次提交都带 due 字段，所以这里必须
        # 比值，不然改个标题都会把手动挪好的排期冲掉
        if "due_date" in body and body["due_date"] and "scheduled_date" not in body:
            nd = _valid_date(body["due_date"])
            if nd and nd != old["due_date"] and not old["no_autosched"]:
                fields.append("scheduled_date=?"); vals.append(nd)
        if not fields:
            raise ValueError("没有要修改的字段")
        vals.append(task_id)
        conn.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id=?", vals)
        conn.commit()
        self._json({"ok": True})

    def _delete_task(self, task_id):
        conn = db()
        t = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not t:
            raise ValueError("任务不存在")
        trash_add(conn, "task", {"task": dict(t)})
        conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        conn.commit()
        self._json({"ok": True})

    def _delete_project(self, project_id):
        """删项目连同它的所有任务；work_logs 保留（工时历史不能丢，统计页按
        project_id 找不到项目时显示「已删除项目」）。
        删之前把项目行和它的全部任务（含已完成）快照进垃圾桶，可在项目页底部恢复。"""
        conn = db()
        p = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not p:
            raise ValueError("项目不存在")
        tasks = [dict(r) for r in
                 conn.execute("SELECT * FROM tasks WHERE project_id=?", (project_id,))]
        trash_add(conn, "project", {"project": dict(p), "tasks": tasks})
        conn.execute("DELETE FROM tasks WHERE project_id=?", (project_id,))
        conn.execute("DELETE FROM projects WHERE id=?", (project_id,))
        conn.commit()
        self._json({"ok": True})

    def _trash_restore(self, entry_id):
        """从垃圾桶恢复：按快照用原 id 插回，并撤掉当初写的滴答墓碑（恢复 = 撤销那次删除）。"""
        conn = db()
        e = conn.execute("SELECT * FROM trash WHERE id=?", (entry_id,)).fetchone()
        if not e:
            raise ValueError("垃圾桶里没有这条记录")
        payload = json.loads(e["payload"])
        if e["kind"] == "project":
            rows = [("projects", payload["project"])] + \
                   [("tasks", t) for t in (payload.get("tasks") or [])]
        elif e["kind"] == "task":
            rows = [("tasks", payload["task"])]
        else:
            raise ValueError(f"无法恢复的类型: {e['kind']}")
        allow = {tb: {r["name"] for r in conn.execute(f"PRAGMA table_info({tb})")}
                 for tb, _ in rows}
        try:
            for tb, row in rows:
                row_insert(conn, tb, row, allow[tb])
        except sqlite3.IntegrityError:
            conn.rollback()
            raise ValueError("恢复失败：原 id 已被新数据占用，请先处理冲突项")
        conn.execute("DELETE FROM trash WHERE id=?", (entry_id,))
        conn.commit()
        res = {"ok": True, "kind": e["kind"], "restored": len(rows)}
        if e["kind"] == "project":
            res["project_id"] = payload["project"].get("id")
        self._json(res)

    def _trash_purge(self, entry_id):
        conn = db()
        # 先查再删：DELETE 命中 0 行也会开写事务，若在这里 raise 而不提交，
        # 留下的事务会一直占着库的写锁（后面所有请求都 500 database is locked）
        if not conn.execute("SELECT 1 FROM trash WHERE id=?", (entry_id,)).fetchone():
            raise ValueError("垃圾桶里没有这条记录")
        conn.execute("DELETE FROM trash WHERE id=?", (entry_id,))
        conn.commit()
        self._json({"ok": True})

    def _trash_empty(self):
        conn = db()
        n = conn.execute("DELETE FROM trash").rowcount
        conn.commit()
        self._json({"ok": True, "cleared": n})

    def _toggle_task(self, task_id):
        conn = db()
        t = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not t:
            raise ValueError("任务不存在")
        if t["done"]:
            removed, kept = undo_generated_next(conn, task_id)
            conn.execute("UPDATE tasks SET done=0, done_at=NULL WHERE id=?", (task_id,))
            conn.commit()
            self._json({"done": 0, "next_id": None,
                        "removed_next": removed, "kept_next": kept})
            return
        next_id = self._mark_done(conn, t)
        self._json({"done": 1, "next_id": next_id})

    def _gen_next(self, conn, t, now, extra):
        """生成本次的「下一件」；这条链上已经有一件没做完的就复用它，不再多插一件。"""
        exist = open_next_of(conn, t["id"])
        if exist:
            return exist
        cols = {"project_id": t["project_id"], "title": t["title"],
                "detail": t["detail"],  # 详情跟着任务走：循环的下一件不该丢掉背景/链接
                "estimate_min": t["estimate_min"], "routine": t["routine"],
                "workday_only": t["workday_only"], "created_at": now,
                "priority": t["priority"], "tags": t["tags"]}
        cols.update(extra)
        cur = conn.execute(
            f"INSERT INTO tasks({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
            tuple(cols.values()))
        next_id = cur.lastrowid
        gen_link(conn, next_id, t["id"])
        return next_id

    def _mark_done(self, conn, t):
        task_id = t["id"]
        today = logical_today(conn)
        now = datetime.now().isoformat(timespec="seconds")
        # 勾选和生成本地下一件必须一次落地：拆成两个事务，连点两下 ☐（或者先撤销再勾）
        # 会各生成一件，长出两条一模一样的
        try:
            begin_write(conn)
            row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row or row["done"]:
                conn.rollback()  # 已经被另一次点击勾掉了，什么都不用做
                return None, False
            t = row
            conn.execute("UPDATE tasks SET done=1, done_at=? WHERE id=?", (now, task_id))
            # 除单次任务外都立刻生成下一件。
            next_id = None
            if t["repeat_type"]:
                # 到期重复：生成下一个实例。提前完成时从本期实例日往后排，
                # 不然下一件可能落回本期规则日（周六提前勾掉下周二的事，下一件还是下周二）
                nd_base = today
                sd = t["scheduled_date"] or t["due_date"]
                if sd and sd > nd_base.isoformat():
                    nd_base = date.fromisoformat(sd)
                nd = next_repeat_date(t, nd_base)
                if nd:
                    next_id = self._gen_next(conn, t, now, {
                        "due_date": nd, "scheduled_date": nd,
                        "repeat_type": t["repeat_type"], "repeat_weekday": t["repeat_weekday"],
                        "repeat_monthday": t["repeat_monthday"],
                        "repeat_ordinal": t["repeat_ordinal"], "skip_holiday": t["skip_holiday"],
                        "repeat_interval": t["repeat_interval"],
                        "same_day": t["same_day"], "lead_days": t["lead_days"]})
            elif t["routine"]:
                # 日常任务：勾掉后生成下一个实例，排到下一个适用日（工作日版跳过周末/节假日）
                nd = today + timedelta(days=1)
                if t["workday_only"]:
                    while not is_workday(nd):
                        nd += timedelta(days=1)
                next_id = self._gen_next(conn, t, now, {
                    "scheduled_date": nd.isoformat()})
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return next_id

    def _timer_start(self, task_id):
        conn = db()
        try:
            begin_write(conn)
            # 查活动计时和插入必须落在同一个写事务里，避免两个并发请求都查到空。
            if conn.execute("SELECT 1 FROM work_logs WHERE end_at IS NULL").fetchone():
                raise ValueError("已有计时进行中，先停止再开始新的")
            t = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not t:
                raise ValueError("任务不存在")
            now = datetime.now().isoformat(timespec="seconds")
            conn.execute(
                "INSERT INTO work_logs(project_id, task_id, start_at, minutes, date) VALUES(?,?,?,0,?)",
                (t["project_id"], task_id, now, logical_today(conn).isoformat()))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        self._json({"ok": True})

    def _timer_stop(self):
        conn = db()
        try:
            begin_write(conn)
            log = conn.execute("SELECT * FROM work_logs WHERE end_at IS NULL").fetchone()
            if not log:
                raise ValueError("当前没有进行中的计时")
            end = datetime.now()
            minutes = max(1, round((end - datetime.fromisoformat(log["start_at"])).total_seconds() / 60))
            cur = conn.execute(
                "UPDATE work_logs SET end_at=?, minutes=? WHERE id=? AND end_at IS NULL",
                (end.isoformat(timespec="seconds"), minutes, log["id"]))
            if cur.rowcount != 1:
                raise ValueError("计时已被停止，请刷新后查看")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        self._json({"minutes": minutes})

    def _timer_finish(self):
        conn = db()
        try:
            begin_write(conn)
            log = conn.execute("SELECT * FROM work_logs WHERE end_at IS NULL").fetchone()
            if not log:
                raise ValueError("当前没有进行中的计时")
            end = datetime.now()
            minutes = max(1, round((end - datetime.fromisoformat(log["start_at"])).total_seconds() / 60))
            cur = conn.execute(
                "UPDATE work_logs SET end_at=?, minutes=? WHERE id=? AND end_at IS NULL",
                (end.isoformat(timespec="seconds"), minutes, log["id"]))
            if cur.rowcount != 1:
                raise ValueError("计时已被停止，请刷新后查看")
            next_id = None
            t = conn.execute("SELECT * FROM tasks WHERE id=?", (log["task_id"],)).fetchone()
            if t and not t["done"]:
                # _mark_done 复用当前事务，工时和完成状态只提交一次。
                next_id = self._mark_done(conn, t)
            else:
                conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        self._json({"minutes": minutes, "done": 1, "next_id": next_id})

    def _manual_log(self, body):
        conn = db()
        minutes = int(body.get("minutes") or 0)
        if minutes <= 0:
            raise ValueError("分钟数必须大于 0")
        day = (body.get("date") or "").strip() or logical_today(conn).isoformat()
        date.fromisoformat(day)
        if not conn.execute("SELECT 1 FROM projects WHERE id=?", (body.get("project_id"),)).fetchone():
            raise ValueError("项目不存在")
        conn.execute(
            "INSERT INTO work_logs(project_id, task_id, task_name, start_at, end_at, minutes, date, note) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (body["project_id"], body.get("task_id"),
             (body.get("task_name") or "").strip() or None,
             day + "T00:00:00", day + "T00:00:00",
             minutes, day, (body.get("note") or "").strip() or None))
        conn.commit()
        self._json({"ok": True})

    def _update_log(self, log_id, body):
        conn = db()
        if not conn.execute("SELECT 1 FROM work_logs WHERE id=?", (log_id,)).fetchone():
            raise ValueError("记录不存在")
        fields, vals = [], []
        if "minutes" in body:
            minutes = int(body["minutes"] or 0)
            if minutes <= 0:
                raise ValueError("分钟数必须大于 0")
            fields.append("minutes=?"); vals.append(minutes)
        if "date" in body:
            day = (body["date"] or "").strip()
            if not day:
                raise ValueError("日期不能为空")
            date.fromisoformat(day)
            fields.append("date=?"); vals.append(day)
            # start_at/end_at 里嵌着日期，改日期时连时间部分一起搬，
            # 否则一条记录自己的字段会互相矛盾
            cur = conn.execute("SELECT start_at, end_at FROM work_logs WHERE id=?",
                               (log_id,)).fetchone()
            for col in ("start_at", "end_at"):
                ts = cur[col]
                if ts and len(ts) >= 11:
                    fields.append(col + "=?"); vals.append(day + ts[10:])
        if "note" in body:
            fields.append("note=?"); vals.append((body["note"] or "").strip() or None)
        if not fields:
            raise ValueError("没有要修改的字段")
        vals.append(log_id)
        conn.execute(f"UPDATE work_logs SET {', '.join(fields)} WHERE id=?", vals)
        conn.commit()
        self._json({"ok": True})

    def _delete_log(self, log_id):
        conn = db()
        if not conn.execute("SELECT 1 FROM work_logs WHERE id=?", (log_id,)).fetchone():
            raise ValueError("记录不存在")
        conn.execute("DELETE FROM work_logs WHERE id=?", (log_id,))
        conn.commit()
        self._json({"ok": True})


if __name__ == "__main__":
    import socket
    import webbrowser
    no_open = "--no-open" in sys.argv  # 开机自启时只起服务不弹浏览器

    # 重启辅助进程入口：必须在正常启动逻辑之前。它只做一件事——等旧实例把端口
    # 让出来（旧进程正在 shutdown），然后继续往下走同一套启动流程。等不到就退出，
    # 绝不抢绑：旧进程还占着端口时硬起新进程，新进程会直接 bind 失败然后没了。
    if "--restart-wait" in sys.argv:
        i = sys.argv.index("--restart-wait")
        old_pid = sys.argv[i + 1] if i + 1 < len(sys.argv) else "?"
        if not wait_port_free(PORT):
            print(f"重启失败：{PORT} 端口一直没让出来（旧进程 {old_pid} 可能没退出），"
                  f"可以手动再启动一次", file=sys.stderr)
            raise SystemExit(1)

    conn0 = db()          # 顺带跑一遍建表/迁移，后面读设置才有表可读
    lan_on = lan_access_enabled(conn0)
    conn0.close()
    host = CLI_HOST or ("0.0.0.0" if lan_on else "127.0.0.1")
    # 启动备份：失败不挡启动，但要留在控制台和设置页里看得见
    try:
        make_backup("启动")
    except Exception as e:
        _backup_error = str(e)
        print(f"启动备份失败：{e}", file=sys.stderr)

    class Server(ThreadingHTTPServer):
        allow_reuse_address = False

        def server_bind(self):
            # Windows 上 SO_REUSEADDR 语义是"允许抢绑"，会导致重复实例静默并存；
            # 独占绑定让第二个实例直接 OSError，走下面的退化逻辑
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    try:
        srv = Server((host, PORT), Handler)
    except OSError as e:
        # 端口被占 = 已经在跑：快捷方式退化为"打开页面"；但若是被别的程序抢走（如动态
        # 端口段里的代理连接），页面也打不开，所以无论如何都留一行可见的错误
        print(f"端口 {PORT} 被占用（{e}）。若页面打不开，说明被别的程序抢了，"
              f"可用 PACE_PORT=别的端口 重启", file=sys.stderr)
        if not no_open:
            webbrowser.open(f"http://localhost:{PORT}")
        raise SystemExit(0)
    set_lan_runtime(lan_on)   # 绑定成功才知道运行态：配置改了没重启，这里仍是旧值
    if not no_open:
        webbrowser.open(f"http://localhost:{PORT}")
    # pid 文件只归正常实例：预览端口可能和主服务并存，不能抢走停止.bat 的目标
    if CLI_PORT is None:
        PID_FILE.write_text(str(os.getpid()))
        atexit.register(remove_pid_file)
    print(f"日拱一卒 v{VERSION} → http://localhost:{PORT}"
          + ("" if lan_on else "（仅本机可访问）"))
    try:
        srv.serve_forever()
    finally:
        # 重启时辅助进程正在等这个端口：主动 close 而不是等进程退出时由 GC 收，
        # 能早几百毫秒让出来，前端轮询等待也就短一点
        srv.server_close()
