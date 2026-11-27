/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The SPIR-V reader (SPIR-V 1.0 sections 2.3 and 2.4): a module's header,
 * its declarations and functions, either byte order, and what is not a
 * module.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decoration, Op, readSpirv } from './spirv-module.js';
import { spirvFixture } from './spirv-fixtures.js';

/** @param {Uint8Array} bytes @returns {import('./spirv-module.js').SpirvModule} */
const read = bytes=>{
    const result = readSpirv(bytes);
    assert.ok('module' in result, 'error' in result ? result.error : '');
    return result.module;
};

test('a module\'s entry points, decorations and functions are read', ()=>{
    const module = read(spirvFixture('twoEntries'));
    assert.equal(module.version, 0x10000);
    assert.deepEqual(module.capabilities, [1], 'Shader');
    assert.deepEqual([...module.imports.values()], ['GLSL.std.450']);
    assert.deepEqual(module.entryPoints.map(e=>[e.model, e.name, e.interface.length]),
        [[0, 'vs', 2], [4, 'fs', 1]]);
    const fs = module.entryPoints[1];
    assert.deepEqual(module.modes.get(fs.id), [{ mode: 8, operands: [] }], 'OriginLowerLeft');
    const colour = fs.interface[0];
    assert.deepEqual(module.decorations.get(colour)?.get(Decoration.Location), [0]);
    const spec = [...module.decorations].find(([, d])=>d.has(Decoration.SpecId));
    assert.equal(module.globals.get(/** @type {any} */ (spec)[0])?.op, Op.SpecConstant);
    assert.deepEqual(module.functions.map(f=>f.blocks.length), [1, 1]);
    assert.equal(module.functions[0].blocks[0].body.at(-1)?.op, Op.Return);
});

test('a big-endian module reads as its little-endian twin', ()=>{
    const bytes = spirvFixture('vertex');
    const swapped = new Uint8Array(bytes.length);
    for (let k = 0; k < bytes.length; k += 4)
    {
        swapped.set(bytes.subarray(k, k + 4).reverse(), k);
    }
    const a = read(bytes);
    const b = read(swapped);
    assert.deepEqual(b.entryPoints, a.entryPoints);
    assert.deepEqual(b.decorations, a.decorations);
    assert.deepEqual(b.memberDecorations, a.memberDecorations);
    assert.equal(b.functions.length, a.functions.length);
});

test('decoration groups give their decorations to each target', ()=>{
    const words = [0x07230203, 0x10000, 0, 20, 0,
        (2 << 16) | Op.Capability, 1,
        (4 << 16) | Op.Decorate, 5, Decoration.Binding, 3,
        (3 << 16) | Op.Decorate, 5, Decoration.Flat,
        (2 << 16) | Op.DecorationGroup, 5,
        (4 << 16) | Op.GroupDecorate, 5, 7, 8,
        (4 << 16) | Op.GroupMemberDecorate, 5, 9, 2];
    const module = read(new Uint8Array(new Uint32Array(words).buffer));
    for (const target of [7, 8])
    {
        assert.deepEqual(module.decorations.get(target)?.get(Decoration.Binding), [3]);
        assert.ok(module.decorations.get(target)?.has(Decoration.Flat));
    }
    assert.deepEqual(module.memberDecorations.get(9)?.get(2)?.get(Decoration.Binding), [3]);
});

test('what is not a module says why', ()=>{
    const good = spirvFixture('fragment');
    /** @param {Uint8Array} bytes */
    const error = bytes=>{
        const result = readSpirv(bytes);
        return 'error' in result ? result.error : null;
    };
    assert.match(String(error(good.subarray(0, 16))), /header/);
    assert.match(String(error(good.subarray(0, 22))), /whole words/);
    const magic = good.slice();
    magic[0] ^= 1;
    assert.match(String(error(magic)), /magic/);
    assert.match(String(error(good.subarray(0, good.length - 4))), /inside a function/,
        'its last OpFunctionEnd cut off');
    const zero = good.slice();
    new DataView(zero.buffer).setUint32(20, 0, true);
    assert.match(String(error(zero)), /runs past/, 'an instruction of no words');
    const long = good.slice();
    new DataView(long.buffer).setUint32(20, (0xffff << 16) | Op.Capability, true);
    assert.match(String(error(long)), /runs past/);
});
