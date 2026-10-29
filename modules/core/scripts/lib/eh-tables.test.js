/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressed, throughGuestHandler, toFrameHandler4 } from './eh-tables.mjs';

/**
 * A function with one try block and a catch funclet, as the compiler writes
 * it for x86_64-pc-windows-msvc, cut to what the rewrite reads.
 */
const SOURCE = `\t.text
"?f@@YAHH@Z":
.Lfunc_begin0:
.seh_proc "?f@@YAHH@Z"
\t.seh_handler __CxxFrameHandler3, @unwind, @except
\tpushq\t%rbp
\t.seh_endprologue
.Ltmp0:
\tcallq\tg
.Ltmp1:
\tretq
\t.seh_handlerdata
\t.long\t("$cppxdata$?f@@YAHH@Z")@IMGREL
\t.text
\t.seh_endproc
"?catch$2@?0??f@@YAHH@Z@4HA":
.seh_proc "?catch$2@?0??f@@YAHH@Z@4HA"
\t.seh_handler __CxxFrameHandler3, @unwind, @except
\tmovq\t%rdx, 16(%rsp)
\t.seh_endprologue
\tleaq\t.Ltmp1(%rip), %rax
\tretq
\t.seh_handlerdata
\t.long\t("$cppxdata$?f@@YAHH@Z")@IMGREL
\t.text
\t.seh_endproc
\t.section\t.xdata,"dr"
"$cppxdata$?f@@YAHH@Z":
\t.long\t429065506                       # MagicNumber
\t.long\t2                               # MaxState
\t.long\t("$stateUnwindMap$?f@@YAHH@Z")@IMGREL # UnwindMap
\t.long\t1                               # NumTryBlocks
\t.long\t("$tryMap$?f@@YAHH@Z")@IMGREL   # TryBlockMap
\t.long\t3                               # IPMapEntries
\t.long\t("$ip2state$?f@@YAHH@Z")@IMGREL # IPToStateXData
\t.long\t40                              # UnwindHelp
\t.long\t0                               # ESTypeList
\t.long\t1                               # EHFlags
"$stateUnwindMap$?f@@YAHH@Z":
\t.long\t-1                              # ToState
\t.long\t0                               # Action
\t.long\t-1                              # ToState
\t.long\t0                               # Action
"$tryMap$?f@@YAHH@Z":
\t.long\t0                               # TryLow
\t.long\t0                               # TryHigh
\t.long\t1                               # CatchHigh
\t.long\t1                               # NumCatches
\t.long\t("$handlerMap$0$?f@@YAHH@Z")@IMGREL # HandlerArray
"$handlerMap$0$?f@@YAHH@Z":
\t.long\t8                               # Adjectives
\t.long\t"??_R0H@8"@IMGREL               # Type
\t.long\t60                              # CatchObjOffset
\t.long\t"?catch$2@?0??f@@YAHH@Z@4HA"@IMGREL # Handler
\t.long\t56                              # ParentFrameOffset
"$ip2state$?f@@YAHH@Z":
\t.long\t.Lfunc_begin0@IMGREL            # IP
\t.long\t-1                              # ToState
\t.long\t.Ltmp0@IMGREL+1                 # IP
\t.long\t0                               # ToState
\t.long\t"?catch$2@?0??f@@YAHH@Z@4HA"@IMGREL # IP
\t.long\t1                               # ToState
\t.text
`;

/** @param {number[]} values */
const bytes = values=>`\t.byte\t${values.join(', ')}`;

test('a function and its catch funclet are pointed at __CxxFrameHandler4\'s tables', ()=>{
    const text = toFrameHandler4(SOURCE);
    assert.doesNotMatch(text, /\.seh_handler __CxxFrameHandler3/);
    assert.equal(text.match(/\.seh_handler __CxxFrameHandler4/g)?.length, 2);
    assert.match(text, /\.long\t"\$fh4info\$\?f@@YAHH@Z"@IMGREL/);
    assert.match(text, /\.long\t"\$fh4info\$\?catch\$2@\?0\?\?f@@YAHH@Z@4HA"@IMGREL/);

    const lines = text.split('\n');
    /** @param {string} label @param {number} count */
    const after = (label, count)=>{
        const at = lines.indexOf(`${label}:`);
        assert.ok(at >= 0, `${label} is defined`);
        return lines.slice(at + 1, at + 1 + count);
    };
    // The function: unwind and try maps, its IP map, EHs; no frame offset.
    assert.deepEqual(after('"$fh4info$?f@@YAHH@Z"', 4), [
        bytes([0x08 | 0x10 | 0x20]),
        '\t.long\t"$fh4unwind$$cppxdata$?f@@YAHH@Z"@IMGREL',
        '\t.long\t"$fh4try$$cppxdata$?f@@YAHH@Z"@IMGREL',
        '\t.long\t"$fh4ip$?f@@YAHH@Z"@IMGREL',
    ]);
    // The funclet is a catch's, with the parent's frame at 56 from its own.
    assert.deepEqual(after('"$fh4info$?catch$2@?0??f@@YAHH@Z@4HA"', 5).filter((_, index)=>
        index === 0 || index === 4), [bytes([0x01 | 0x08 | 0x10 | 0x20]), bytes(compressed(56))]);
    // Two entries chaining to the empty state: one byte each, back past the start.
    assert.deepEqual(after('"$fh4unwind$$cppxdata$?f@@YAHH@Z"', 3),
        [bytes([2 << 1]), bytes(compressed(1 << 2)), bytes(compressed(2 << 2))]);
    // The handler: adjectives, type, catch object, funclet.
    assert.deepEqual(after('"$fh4handlers$0$$cppxdata$?f@@YAHH@Z"', 6), [
        bytes([1 << 1]), bytes([0x07]), bytes(compressed(8)), '\t.long\t"??_R0H@8"@IMGREL',
        bytes(compressed(60)), '\t.long\t"?catch$2@?0??f@@YAHH@Z@4HA"@IMGREL',
    ]);
    // Each procedure's IP map holds its own entries, deltas from its start.
    assert.deepEqual(after('"$fh4ip$?f@@YAHH@Z"', 7), [
        bytes([2 << 1]),
        bytes([0x0f]), '\t.long\t(.Lfunc_begin0+0)-("?f@@YAHH@Z")', bytes(compressed(0)),
        bytes([0x0f]), '\t.long\t(.Ltmp0+1)-(.Lfunc_begin0+0)', bytes(compressed(1)),
    ]);
    assert.deepEqual(after('"$fh4ip$?catch$2@?0??f@@YAHH@Z@4HA"', 3),
        [bytes([1 << 1]), bytes(compressed(0)), bytes(compressed(2))]);
});

test('frames of a chosen function are handed to the program\'s own handler', ()=>{
    const text = throughGuestHandler(SOURCE, '?catch$2', 'guest_language_handler');
    assert.equal(text.match(/\.seh_handler guest_language_handler/g)?.length, 1);
    assert.equal(text.match(/\.seh_handler __CxxFrameHandler3/g)?.length, 1);
    assert.throws(()=>throughGuestHandler(SOURCE, 'nothing', 'h'), /no frame/);
});
