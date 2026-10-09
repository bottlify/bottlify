/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cork.mjs', import.meta.url));

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * Flat code at 0x1000: write(1, "hello\n", 6), a loop of a million turns
 * summing into esi, exit(42) -- Linux i386's calls through `int 0x80`.
 */
function hello(){
    const at = 0x1000;
    const head = [0xb8, ...u32(4), 0xbb, ...u32(1), 0xb9, 0, 0, 0, 0, 0xba, ...u32(6), 0xcd, 0x80,
        0xb9, ...u32(1_000_000), 0x31, 0xf6, 0x01, 0xce, 0x49, 0x75, 0xfb,
        0xb8, ...u32(1), 0xbb, ...u32(42), 0xcd, 0x80];
    head.splice(11, 4, ...u32(at + head.length));
    return Uint8Array.from([...head, ...Buffer.from('hello\n')]);
}

/** @param {string[]} args */
const cork = args=>spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('cork run: a flat program under --linux writes, loops translated and exits', ()=>{
    const dir = mkdtempSync(join(tmpdir(), 'cork-cli-'));
    try
    {
        const file = join(dir, 'hello.bin');
        writeFileSync(file, hello());
        const linux = cork(['run', file, '--linux']);
        assert.equal(linux.status, 42, linux.stderr);
        assert.equal(linux.stdout, 'hello\n');
        assert.match(linux.stderr, /stopped: exit 42/);
        // Without --linux the first int 0x80 is the caller's: the run stops there.
        const bare = cork(['run', file, '--json']);
        assert.equal(bare.status, 1);
        const report = JSON.parse(bare.stdout);
        assert.equal(report.stop, 'interrupt');
        assert.equal(report.vector, 0x80);
        assert.equal(report.registers.eip, 0x1016);
        const json = JSON.parse(cork(['run', file, '--linux', '--json']).stdout.split('\n')
            .find(line=>line.startsWith('{')) ?? '{}');
        assert.equal(json.exitCode, 42);
        assert.ok(json.translated > 1_000_000, `translated ${json.translated}`);
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('cork translate: one region as a valid wasm module', ()=>{
    const dir = mkdtempSync(join(tmpdir(), 'cork-cli-'));
    try
    {
        const file = join(dir, 'hello.bin');
        const out = join(dir, 'loop.wasm');
        writeFileSync(file, hello());
        const result = cork(['translate', file, '--entry', '0x1016', '-o', out]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /blocks/);
        const wasm = readFileSync(out);
        assert.ok(WebAssembly.validate(wasm));
        const imports = WebAssembly.Module.imports(new WebAssembly.Module(wasm));
        assert.ok(imports.some(one=>one.name === 'memory' && one.kind === 'memory'));
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('cork without a command prints its usage and fails', ()=>{
    const result = cork([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/);
});
