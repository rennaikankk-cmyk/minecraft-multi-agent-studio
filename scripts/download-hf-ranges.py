#!/usr/bin/env python3
"""Resumable, range-parallel downloader for immutable Hugging Face LFS blobs."""

from __future__ import annotations

import concurrent.futures
import hashlib
import os
import re
import sys
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen


REPO = "spele1100/Ornith-1.5-35B-A3B-Heretic-GB10-NVFP4"
REVISION = "c56d7696e9022d5d76ae211021924ac5a2d8aa95"
TARGET = Path(
    "/home/rennaikank/models/spele1100--Ornith-1.5-35B-A3B-Heretic-GB10-NVFP4"
) / REVISION
CHUNK_SIZE = 32 * 1024 * 1024
WORKERS = 16
TIMEOUT_SECONDS = 180

FILES = {
    "model-00001-of-00005.safetensors": (
        4478118816,
        "d0f2cef7fab3f15ddd32b599351096472ad496fdd434cccb059bd60bf48d4d98",
    ),
    "model-00002-of-00005.safetensors": (
        4492894920,
        "1253296b9d2b8013f492f4af6812d614a8b567e6a0ff5bc9da55c67f8f20d54c",
    ),
    "model-00003-of-00005.safetensors": (
        4492834520,
        "c3db76eacbc8495476bbd3abb8d23c8c9d180f46e36a8db75cdc80d7bdb32467",
    ),
    "model-00004-of-00005.safetensors": (
        4493094440,
        "a66861217008829cdec42c65f99d3a4ac6f8cb36fa85a8a85031600ddab3f2fe",
    ),
    "model-00005-of-00005.safetensors": (
        4506904176,
        "f2067b9b878af66caeb3e75c44c685007147aa6ce01a006ca4be990486e9b97c",
    ),
}


def source_url(name: str) -> str:
    return (
        f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}"
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(16 * 1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def fetch_range(name: str, start: int, end: int, destination: Path, fd: int) -> int:
    expected = end - start + 1
    last_error: Exception | None = None
    for attempt in range(1, 9):
        try:
            request = Request(
                source_url(name),
                headers={"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"},
            )
            with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                content_range = response.headers.get("Content-Range", "")
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
                if response.status != 206 or not match:
                    raise RuntimeError(
                        f"unexpected response status={response.status} range={content_range!r}"
                    )
                if int(match.group(1)) != start or int(match.group(2)) != end:
                    raise RuntimeError(f"wrong content range: {content_range!r}")
                offset = start
                received = 0
                while received < expected:
                    block = response.read(min(1024 * 1024, expected - received))
                    if not block:
                        raise ConnectionError(
                            f"short response at {received}/{expected} bytes"
                        )
                    os.pwrite(fd, block, offset)
                    offset += len(block)
                    received += len(block)
                if received != expected:
                    raise ConnectionError(f"received {received}, expected {expected}")
                return received
        except Exception as error:  # pragma: no cover - network-dependent
            last_error = error
            time.sleep(min(30, attempt * 2))
    raise RuntimeError(f"range {name} {start}-{end} failed: {last_error}")


def download(name: str, size: int, expected_hash: str) -> None:
    destination = TARGET / name
    part = TARGET / f".{name}.part"
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size == size:
        actual = sha256(destination)
        if actual == expected_hash:
            print(f"{name}: already verified", flush=True)
            return
        destination.unlink()
    if part.exists() and part.stat().st_size > size:
        part.unlink()
    existing = part.stat().st_size if part.exists() else 0
    if existing == 0:
        hf_download = TARGET / ".cache" / "huggingface" / "download"
        matching = sorted(hf_download.glob(f"*.{expected_hash}.*.incomplete"))
        if matching:
            candidate = max(matching, key=lambda path: path.stat().st_size)
            candidate_size = candidate.stat().st_size
            if 0 < candidate_size < size:
                candidate.replace(part)
                existing = candidate_size
                print(
                    f"{name}: adopted Hugging Face partial {candidate_size} bytes",
                    flush=True,
                )
    if existing == 0:
        with part.open("wb"):
            pass
    fd = os.open(part, os.O_RDWR)
    os.ftruncate(fd, size)
    ranges = []
    start = existing
    while start < size:
        end = min(size - 1, start + CHUNK_SIZE - 1)
        ranges.append((start, end))
        start = end + 1
    total = sum(end - start + 1 for start, end in ranges)
    completed = 0
    lock = threading.Lock()
    started = time.monotonic()
    print(
        f"{name}: resume={existing} remaining={total} ranges={len(ranges)}",
        flush=True,
    )
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futures = [
                pool.submit(fetch_range, name, start, end, part, fd)
                for start, end in ranges
            ]
            for future in concurrent.futures.as_completed(futures):
                count = future.result()
                with lock:
                    completed += count
                    elapsed = max(0.001, time.monotonic() - started)
                    print(
                        f"{name}: {existing + completed}/{size} "
                        f"({(existing + completed) / size:.1%}) "
                        f"{completed / elapsed / 1024 / 1024:.2f} MiB/s",
                        flush=True,
                    )
        os.fsync(fd)
    finally:
        os.close(fd)
    actual = sha256(part)
    if actual != expected_hash:
        raise RuntimeError(f"{name}: SHA256 mismatch {actual} != {expected_hash}")
    os.replace(part, destination)
    print(f"{name}: verified {actual}", flush=True)


def main() -> int:
    for name, (size, expected_hash) in FILES.items():
        download(name, size, expected_hash)
    return 0


if __name__ == "__main__":
    sys.exit(main())
