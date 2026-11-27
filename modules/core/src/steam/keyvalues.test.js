/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBinary, parseText } from './keyvalues.js';

test('text: nesting, comments, escapes, unquoted tokens and platform conditions', ()=>{
    const text = `"appinfo"
{
    // a comment
    "appid"     "440"
    "common"
    {
        "name"  "Team \\"Fortress\\" 2"
        "type"  "Game"
        oslist  windows
    }
    "launch" { "0" { "executable" "hl2.exe" [$WIN32] } }
}\0`;
    assert.deepEqual(parseText(text), {
        appinfo: {
            appid: '440',
            common: { name: 'Team "Fortress" 2', type: 'Game', oslist: 'windows' },
            launch: { 0: { executable: 'hl2.exe' } },
        },
    });
    assert.throws(()=>parseText('"a" { "b" "c"'), SyntaxError);
});

test('binary: subtrees, strings, integers and both end markers', ()=>{
    const parts = [
        [0], 'root\0',
        [1], 'name\0', 'Pack\0',
        [2], 'packageid\0', [0x2A, 0, 0, 0],
        [7], 'big\0', [1, 0, 0, 0, 0, 0, 0, 0x80],
        [0], 'appids\0',
        [2], '0\0', [0xB8, 1, 0, 0],
        [8],
        [8],
        [8],
    ];
    const bytes = Uint8Array.from(parts.flatMap(part=>(typeof part === 'string'
        ? [...Buffer.from(part)] : part)));
    assert.deepEqual(parseBinary(bytes), {
        root: { name: 'Pack', packageid: 42, big: 0x8000000000000001n, appids: { 0: 440 } },
    });
    assert.throws(()=>parseBinary(Uint8Array.of(2, 0x61, 0, 1)), RangeError);
});
