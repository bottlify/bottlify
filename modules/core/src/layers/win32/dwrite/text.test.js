/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BREAK, JUSTIFY, SCRIPT, SHAPES, bidiLevels, itemize, justification, lineBreakpoints,
    mirrored, scriptOf } from './text.js';

test('scripts are numbered in Windows\' order and Common text joins the run beside it', ()=>{
    assert.equal(SCRIPT.Arab, 3);
    assert.equal(SCRIPT.Latn, 49);
    assert.equal(scriptOf(0x41), SCRIPT.Latn);
    assert.equal(scriptOf(0x3e2), SCRIPT.Copt, 'Coptic letters inside the Greek block');
    assert.deepEqual(itemize('ab 12 cd'), [{ at: 0, length: 8, script: SCRIPT.Latn,
        shapes: SHAPES.DEFAULT }]);
    assert.deepEqual(itemize('aم').map(run=>[run.at, run.length, run.script]),
        [[0, 1, SCRIPT.Latn], [1, 1, SCRIPT.Arab]]);
    assert.deepEqual(itemize(' a').map(run=>run.script), [SCRIPT.Latn], 'leading space');
    assert.deepEqual(itemize('a\u0001b').map(run=>run.shapes),
        [SHAPES.DEFAULT, SHAPES.NO_VISUAL, SHAPES.DEFAULT], 'controls draw nothing');
    assert.deepEqual(itemize('𝅳').map(run=>[run.length, run.shapes]),
        [[2, SHAPES.NO_VISUAL]], 'a supplementary format character is one run of two units');
});

test('bidi levels: strong text, numbers, boundary neutrals and embeddings', ()=>{
    const levels = (/** @type {string} */ text, /** @type {number} */ base)=>{
        const { explicit, resolved } = bidiLevels(text, base);
        return [[...explicit], [...resolved]];
    };
    const arabic = 'می‌کنم';
    assert.deepEqual(levels(arabic, 0), [[0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1]]);
    assert.deepEqual(levels('‌می', 0), [[0, 0, 0], [0, 1, 1]],
        'a joiner at the start takes the paragraph\'s level');
    assert.deepEqual(levels('A‌B', 1), [[1, 1, 1], [2, 2, 2]]);
    assert.deepEqual(levels('a‫‬b', 1), [[1, 3, 3, 1], [2, 2, 2, 2]], 'RLE PDF');
    assert.deepEqual(levels('a‫‬b', 0), [[0, 1, 1, 0], [0, 0, 0, 0]],
        'RLE in a left to right paragraph opens level 1');
    assert.deepEqual(levels('‪‬ab', 1), [[2, 2, 1, 1], [1, 1, 2, 2]], 'LRE PDF');
    assert.deepEqual(levels('‬ab', 0), [[0, 0, 0], [0, 0, 0]], 'a PDF closing nothing');
    assert.deepEqual(levels('א 12', 0)[1], [1, 1, 2, 2], 'numbers after Hebrew stand above');
});

test('line breakpoints follow the break classes', ()=>{
    const at = (/** @type {string} */ text)=>[...lineBreakpoints(text)].map(byte=>
        [byte & 3, byte >> 2 & 3, byte >> 4 & 1]);
    const { MAY_NOT_BREAK: NB, CAN_BREAK: CB, MUST_BREAK: B } = BREAK;
    assert.deepEqual(at('a b'), [[NB, NB, 0], [NB, CB, 1], [CB, CB, 0]]);
    assert.deepEqual(at('a-b'), [[NB, NB, 0], [NB, CB, 0], [CB, CB, 0]], 'after a hyphen');
    assert.deepEqual(at('a֊b').map(([, after])=>after), [NB, CB, CB], 'break-after class');
    assert.deepEqual(at('張G「').map(([before, after])=>[before, after]),
        [[NB, CB], [CB, NB], [NB, CB]], 'no break before an opening bracket after a letter');
    assert.deepEqual(at('a\nb').map(([before, after, white])=>[before, after, white]),
        [[NB, NB, 0], [NB, B, 1], [B, CB, 0]]);
    assert.equal(lineBreakpoints('a­b')[1] & 0x20, 0x20, 'a soft hyphen is marked');
});

test('justification: blanks in Latin, joined shapes in Arabic', ()=>{
    const codes = (/** @type {string} */ text)=>[...text].map(c=>c.codePointAt(0) ?? 0);
    assert.deepEqual(justification(codes('a b\tc'), false), [JUSTIFY.CHARACTER, JUSTIFY.BLANK,
        JUSTIFY.CHARACTER, JUSTIFY.BLANK, JUSTIFY.CHARACTER]);
    assert.deepEqual(justification(codes('سا'), true),
        [JUSTIFY.ARABIC_SEEN, JUSTIFY.ARABIC_ALEF]);
    assert.deepEqual(justification(codes('لسم'), true),
        [JUSTIFY.NONE, JUSTIFY.ARABIC_SEEN_M, JUSTIFY.ARABIC_NORMAL]);
    assert.deepEqual(justification(codes('بر'), true), [JUSTIFY.NONE, JUSTIFY.ARABIC_BARA]);
    assert.deepEqual(justification(codes('له'), true), [JUSTIFY.NONE, JUSTIFY.ARABIC_HA]);
    assert.deepEqual(justification(codes(' ـ'), true), [JUSTIFY.ARABIC_BLANK,
        JUSTIFY.ARABIC_KASHIDA]);
    assert.equal(mirrored(0x28), 0x29);
});
