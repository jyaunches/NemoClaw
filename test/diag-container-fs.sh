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
echo "=== Test 3: Node.js renameSync + cpSync (isolated /tmp test) ==="
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

echo ""
echo "=== Test 4: Verbose rollbackFromSnapshot (exact E2E code path) ==="
echo "--- Inspecting real .openclaw directory structure ---"
ls -la "$HOME/.openclaw/" 2>/dev/null || echo "$HOME/.openclaw does not exist"
ls -la "$HOME/.openclaw-data/" 2>/dev/null || echo "$HOME/.openclaw-data does not exist"
ls -la /sandbox/.openclaw/ 2>/dev/null || echo "/sandbox/.openclaw does not exist"
ls -la /sandbox/.openclaw-data/ 2>/dev/null || echo "/sandbox/.openclaw-data does not exist"
echo "HOME=$HOME"
echo "--- Filesystem type for HOME dirs ---"
stat -f -c "$HOME/.openclaw : type=%T" "$HOME/.openclaw" 2>/dev/null || echo "cannot stat $HOME/.openclaw"
stat -f -c "$HOME/.nemoclaw : type=%T" "$HOME/.nemoclaw" 2>/dev/null || echo "cannot stat $HOME/.nemoclaw"

echo ""
echo "--- Running rollback with verbose error capture ---"
node --input-type=module -e "
  import fs from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';

  // Replicate the exact E2E flow: createSnapshot then rollbackFromSnapshot
  const { createSnapshot, listSnapshots } = await import('/opt/nemoclaw/dist/blueprint/snapshot.js');

  console.log('HOME:', os.homedir());
  const openclawDir = path.join(os.homedir(), '.openclaw');
  const nemoDir = path.join(os.homedir(), '.nemoclaw');

  console.log('.openclaw exists:', fs.existsSync(openclawDir));
  console.log('.nemoclaw exists:', fs.existsSync(nemoDir));

  if (fs.existsSync(openclawDir)) {
    console.log('.openclaw contents:', fs.readdirSync(openclawDir));
    // Check each entry for symlinks
    for (const entry of fs.readdirSync(openclawDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        console.log('  SYMLINK:', entry.name, '->', fs.readlinkSync(path.join(openclawDir, entry.name)));
      } else if (entry.isDirectory()) {
        console.log('  DIR:', entry.name);
      } else {
        console.log('  FILE:', entry.name);
      }
    }
  }

  // Create snapshot
  const snap = createSnapshot();
  console.log('Snapshot created at:', snap);
  if (!snap) { console.log('SKIP: no snapshot to test with'); process.exit(0); }

  const snaps = listSnapshots();
  console.log('Snapshot count:', snaps.length);
  const snapPath = snaps[0].path;
  const source = path.join(snapPath, 'openclaw');
  console.log('Snapshot source dir:', source);
  console.log('Snapshot source exists:', fs.existsSync(source));
  console.log('Snapshot source contents:', fs.readdirSync(source));

  // Simulate corruption like the E2E does
  const configPath = path.join(openclawDir, 'openclaw.json');
  if (fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ corrupted: true }));
    console.log('Corrupted config at:', configPath);
  }

  // Now do the rollback manually with verbose errors (not using rollbackFromSnapshot)
  const archivePath = path.join(os.homedir(), '.openclaw.diag-archived.' + Date.now());

  console.log('');
  console.log('--- Step 1: renameSync .openclaw to archive ---');
  try {
    fs.renameSync(openclawDir, archivePath);
    console.log('PASS: renameSync succeeded. Archived to:', archivePath);
  } catch (e) {
    console.log('FAIL: renameSync error:', e.code, e.syscall, e.message);
    console.log('Full error:', JSON.stringify({
      code: e.code, errno: e.errno, syscall: e.syscall,
      path: e.path, dest: e.dest, stack: e.stack
    }, null, 2));
  }

  console.log('.openclaw exists after rename:', fs.existsSync(openclawDir));
  console.log('archive exists after rename:', fs.existsSync(archivePath));

  console.log('');
  console.log('--- Step 2: cpSync snapshot to .openclaw ---');
  try {
    fs.cpSync(source, openclawDir, { recursive: true });
    console.log('PASS: cpSync succeeded');
    console.log('Restored .openclaw contents:', fs.readdirSync(openclawDir));
  } catch (e) {
    console.log('FAIL: cpSync error:', e.code, e.syscall, e.message);
    console.log('Full error:', JSON.stringify({
      code: e.code, errno: e.errno, syscall: e.syscall,
      path: e.path, dest: e.dest, stack: e.stack
    }, null, 2));
  }
" 2>&1 || echo "Node script exited with error (see above)"
