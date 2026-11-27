#!/usr/bin/env python3
"""生成 daily-pace 的 GitHub Pages 更新包。

从 daily-pace/app.py 里正则解析 VERSION，把可更新文件按相对路径拷到
docs/release/，并生成 manifest.json（sha256 校验表）。

用法：
    cd daily-ace
    python tools/make_release.py

注意：本脚本只生成发布目录，不执行 git add、commit 或 push，由维护者统一处理。
"""

import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# 可更新文件规则：逐个点名，避免把私人脚本或开发记录卷进公开更新源。
RELEASE_FILES = [
    "app.py",
    "static/**/*",
    "启动.bat",
    "停止.bat",
    "生成快捷方式.bat",
    "使用说明.txt",
    "更新日志.txt",
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def parse_version(app_py: Path) -> str:
    text = app_py.read_text(encoding="utf-8")
    m = re.search(r'^VERSION\s*=\s*["\']([^"\']+)["\']', text, re.MULTILINE)
    if not m:
        raise SystemExit(f"无法在 {app_py} 中解析 VERSION")
    return m.group(1)


def collect_files(src_dir: Path) -> list[Path]:
    """按 RELEASE_FILES 规则收集文件，返回相对于 src_dir 的 Path 列表。"""
    collected: set[Path] = set()
    for pattern in RELEASE_FILES:
        if pattern.endswith("/**/*"):
            base = pattern[:-4]
            root = src_dir / base
            if root.is_dir():
                for p in root.rglob("*"):
                    if p.is_file():
                        collected.add(p.relative_to(src_dir))
        else:
            for p in src_dir.glob(pattern):
                if p.is_file():
                    collected.add(p.relative_to(src_dir))
    return sorted(collected, key=lambda p: str(p).replace("\\", "/"))


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    src_dir = repo
    release_dir = repo / "docs" / "release"
    app_py = src_dir / "app.py"

    if not app_py.is_file():
        print(f"找不到 {app_py}", file=sys.stderr)
        return 1

    version = parse_version(app_py)
    print(f"解析到版本号：{version}")

    # 清空旧发布目录
    if release_dir.exists():
        shutil.rmtree(release_dir)
    release_dir.mkdir(parents=True, exist_ok=True)

    files = collect_files(src_dir)
    manifest_files: dict[str, str] = {}

    for rel in files:
        src = src_dir / rel
        dst = release_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        key = str(rel).replace("\\", "/")
        manifest_files[key] = sha256_file(dst)

    manifest = {
        "version": version,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "files": manifest_files,
    }
    manifest_path = release_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8")

    print(f"已生成 {release_dir}")
    print(f"共 {len(files)} 个文件，版本 {version}")
    print(f"manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
