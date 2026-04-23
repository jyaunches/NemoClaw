#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Diagnostic script: compare filesystem behavior across Docker storage drivers.
# Mounted into the sandbox container by the diagnose-snapshot-rollback CI job.
# Temporary — will be removed once the root cause is identified and fixed.

set -uo pipefail

echo "=== Container OS ==="
cat /etc/os-release | head -5

echo ""
echo "=== Filesystem type for key dirs ==="
stat -f -c "/ : type=%T" / 2>/dev/null || stat -f / 2>/dev/null
stat -f -c "/sandbox : type=%T" /sandbox 2>/dev/null || echo "/sandbox not found"
stat -f -c "/tmp : type=%T" /tmp 2>/dev/null || stat -f /tmp 2>/dev/null

echo ""
echo "=== Mount table inside container ==="
mount | head -20

echo ""
echo "=== Symlink test: create symlink dir structure like .openclaw ==="
mkdir -p /tmp/diag-test/real-data/subdir
echo "file1" > /tmp/diag-test/real-data/config.json
echo "file2" > /tmp/diag-test/real-data/subdir/nested.txt
mkdir -p /tmp/diag-test/symlinked
ln -s /tmp/diag-test/real-data/config.json /tmp/diag-test/symlinked/config.json
ln -s /tmp/diag-test/real-data/subdir /tmp/diag-test/symlinked/subdir
echo "Created symlink structure:"
ls -la /tmp/diag-test/symlinked/

echo ""
echo "=== Test 1: renameSync equivalent (mv) on symlink dir ==="
mv /tmp/diag-test/symlinked /tmp/diag-test/symlinked.bak && echo "PASS: mv succeeded" || echo "FAIL: mv failed"
ls -la /tmp/diag-test/symlinked.bak/ 2>/dev/null

echo ""
echo "=== Test 2: cpSync equivalent (cp -a) to recreate dir with symlinks ==="
cp -a /tmp/diag-test/symlinked.bak /tmp/diag-test/symlinked-restored && echo "PASS: cp -a succeeded" || echo "FAIL: cp -a failed"
ls -la /tmp/diag-test/symlinked-restored/ 2>/dev/null

echo ""
echo "=== Test 3: Node.js renameSync + cpSync (exact rollback code path) ==="
node -e '
  const fs = require("fs");

  const base = "/tmp/diag-node";
  fs.mkdirSync(base + "/openclaw-data/workspace", { recursive: true });
  fs.writeFileSync(base + "/openclaw-data/openclaw.json", JSON.stringify({ test: true }));
  fs.writeFileSync(base + "/openclaw-data/workspace/notes.md", "hello");
  fs.mkdirSync(base + "/openclaw", { recursive: true });
  fs.symlinkSync(base + "/openclaw-data/openclaw.json", base + "/openclaw/openclaw.json");
  fs.symlinkSync(base + "/openclaw-data/workspace", base + "/openclaw/workspace");

  console.log("Setup complete. Structure:");
  console.log("  openclaw/openclaw.json ->", fs.readlinkSync(base + "/openclaw/openclaw.json"));
  console.log("  openclaw/workspace ->", fs.readlinkSync(base + "/openclaw/workspace"));

  try {
    fs.renameSync(base + "/openclaw", base + "/openclaw.archived");
    console.log("PASS: renameSync succeeded");
  } catch (e) {
    console.log("FAIL: renameSync error:", e.code, e.message);
  }

  const snapshot = base + "/openclaw-data";
  try {
    fs.cpSync(snapshot, base + "/openclaw", { recursive: true });
    console.log("PASS: cpSync succeeded");
    const files = fs.readdirSync(base + "/openclaw");
    console.log("Restored contents:", files);
  } catch (e) {
    console.log("FAIL: cpSync error:", e.code, e.message);
    console.log("Full error:", JSON.stringify({ code: e.code, errno: e.errno, syscall: e.syscall, path: e.path, dest: e.dest }));
  }
'
