#!/usr/bin/env python3
"""Behavioral regression suite for AetherTerm diskSync.ts and server entry points."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent

def check_disk_sync(mutate: bool = False) -> None:
    src = (ROOT / 'diskSync.ts').read_text(encoding='utf-8')
    if mutate:
        src = src.replace("segs.some((s) => s === '..' || s === '.')", 'false')
    assert "segs.some((s) => s === '..' || s === '.')" in src, 'EXPECTED REGRESSION DETECTED: path traversal guard missing'
    assert 'export function safeResolve(vfsPath: string)' in src, 'safeResolve missing'
    assert 'export async function writeThrough(' in src, 'writeThrough missing'
    assert 'export function startWatcher(' in src, 'startWatcher missing'
    if 'watcherQueue' in src:
        assert 'export function flushWatcherQueue()' in src, 'flushWatcherQueue missing'
    if 'expectedSha256' in src:
        assert 'export function getSyncConflicts()' in src, 'getSyncConflicts missing'

if __name__ == '__main__':
    mutate_flag = '--mutate' in sys.argv
    try:
        check_disk_sync(mutate=mutate_flag)
    except AssertionError as exc:
        print(str(exc))
        raise SystemExit(1)
    print('REGRESSION CHECKS PASSED')
