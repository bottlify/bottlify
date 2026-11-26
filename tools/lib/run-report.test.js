/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeProcesses, describeRunCache } from './run-report.mjs';

const MIB = 1024 * 1024;

test('the run cache line carries the budget, what the keeper holds now and at most', ()=>{
    const line = describeRunCache({ budget: 160 * MIB, segments: 2, segmentBytes: 32 * MIB,
        peakSegmentBytes: 48 * MIB, placedBytes: 20 * MIB, peakPlacedBytes: 40 * MIB,
        hot: 3, hotBytes: 20 * MIB, cold: 1, coldBytes: 6 * MIB, written: 1,
        writtenBytes: 6 * MIB, cooled: 1, raised: 2, gone: 4, refusedRoom: 0, refusedLarge: 0 });
    for (const part of ['budget 160.0 MiB', 'segments 2 (32.0 MiB, at most 48.0)',
        'placed 20.0 MiB (at most 40.0)', 'hot 3', 'cold 1 (6.0 MiB)', 'written 1', 'gone 4'])
    {
        assert.ok(line.includes(part), `${part} in ${line}`);
    }
});

test('the run cache line weighs each space: its bodies, their blocks, what rounding costs', ()=>{
    const figures = { budget: 160 * MIB, segments: 1, segmentBytes: 32 * MIB,
        peakSegmentBytes: 32 * MIB, placedBytes: 12288, peakPlacedBytes: 12288, hot: 3,
        hotBytes: 5000, cold: 0, coldBytes: 0, written: 0, writtenBytes: 0, gone: 0 };
    const line = describeRunCache({ ...figures, spaces: {
        reads: { bodies: 2, bytes: 1000, hotBytes: 1000, placedBytes: 8192 },
        texels: { bodies: 1, bytes: 4096, hotBytes: 4096, placedBytes: 4096 } } });
    assert.ok(line.includes('; reads: 2 bodies (0.0 MiB), in memory 0.0 MiB in blocks of 0.0 MiB,'
        + ' rounding 88 %'), line);
    assert.ok(line.includes('; texels: 1 bodies'), line);
    assert.ok(line.includes('rounding 0 %'), line);
    assert.ok(describeRunCache(figures).endsWith('; spaces not measured'));
});

test('a run cache that did not answer says so, never a zero', ()=>{
    assert.equal(describeRunCache(undefined), 'run cache: not measured');
    assert.equal(describeRunCache('not measured: kept elsewhere'),
        'run cache: not measured: kept elsewhere');
});

test('the processes line names the process the report is of and every process\'s frames', ()=>{
    const lines = describeProcesses([
        { image: '3DMark06.exe', frames: 4200, worker: false, chosen: true },
        { image: 'fmsiscan.exe', frames: null, worker: true, chosen: false }]);
    assert.match(lines[0], /report of 3DMark06\.exe/);
    assert.match(lines[1], /\* 3DMark06\.exe: 4200 frames/);
    assert.match(lines[2], /fmsiscan\.exe \(worker\): frames not measured/);
    const none = describeProcesses([{ image: 'a.exe', frames: 0, worker: false, chosen: false }]);
    assert.match(none[0], /facade/);
    assert.deepEqual(describeProcesses(undefined), ['processes: not measured']);
});
