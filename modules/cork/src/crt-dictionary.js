/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The dictionary of C runtime functions a program links into its own image:
 * Microsoft's memcpy, memmove, memset, strlen and sqrt of the runtimes from
 * Visual C++ 7.1 to 14, by their signatures (`helpers.js`), and the operation
 * a call to each is formed as (`emit/crt.js`).
 *
 * Each signature is the library's own function as `tools/crt-dictionary.mjs`
 * reads it out of the runtime's DLL -- its code's spans from its entry, the
 * bytes that differ where it is linked masked -- and each was run against its
 * operation by `--verify` on seeded arguments, through every way the
 * function takes by the processor's features, before it was put here. A
 * program's own copy is the same object linked elsewhere: its signature is the
 * library's. Only fingerprints and offsets are kept, never the code.
 *
 * Every `memcpy` here copies as `memmove` does -- overlapping source and
 * destination included, as each of these runtimes' own does -- and is formed
 * as `memmove`.
 */

/** @typedef {import('./helpers.js').RuntimeHelper} RuntimeHelper */

/**
 * The square root a `sqrt` call is formed as once its argument is not below
 * zero: the x87's, rounded as the control word's precision says -- each of
 * these runtimes takes `fsqrt` there, and a Direct3D 9 program runs with the
 * precision at single -- returned in ST0.
 */
const SQRT_BODY = Object.freeze([
    0xdd, 0x04, 0x24,                       // fld qword [esp]
    0xd9, 0xfa,                             // fsqrt
]);

/**
 * floor's and ceil's rounding once its argument is finite: SSE4.1's `roundsd`
 * toward minus or plus infinity, exact, returned in ST0.
 *
 * @param {number} mode  roundsd's immediate: 1 down, 2 up
 */
const roundBody = mode=>Object.freeze([
    0xf2, 0x0f, 0x10, 0x04, 0x24,           // movsd xmm0, [esp]
    0x66, 0x0f, 0x3a, 0x0b, 0xc0, mode,     // roundsd xmm0, xmm0, mode
    0xf2, 0x0f, 0x11, 0x44, 0x24, 0xf8,     // movsd [esp-8], xmm0
    0xdd, 0x44, 0x24, 0xf8,                 // fld qword [esp-8]
]);

/**
 * The body a call to a function doing `does` goes on with after its test
 * (`emit/crt.js`), for the operations that have one.
 *
 * @type {Readonly<Partial<Record<import('./helpers.js').Crt, readonly number[]>>>}
 */
export const CRT_BODIES = Object.freeze({
    sqrt: SQRT_BODY, floor: roundBody(1), ceil: roundBody(2),
});

/**
 * An entry: its masks given as runs `[offset, length]`, its length from its
 * spans.
 *
 * @param {{ name: string, does: import('./helpers.js').Crt, quick: string, hash: string,
 *     body?: readonly number[], spans: number[][], masks: number[][], bits?: 32 | 64 }} given
 * @returns {RuntimeHelper}
 */
function entry({ masks, ...given }){
    const body = CRT_BODIES[given.does];
    const first = Math.min(...given.spans.map(([offset])=>offset));
    const end = Math.max(...given.spans.map(([offset, length])=>offset + length));
    return Object.freeze({
        ...given,
        ...body === undefined ? {} : { body },
        length: end - first,
        masks: Object.freeze(masks.flatMap(([offset, length])=>
            Array.from({ length }, (unused, k)=>/** @type {number} */ (offset + k)))),
    });
}

/** @type {readonly RuntimeHelper[]} */
export const CRT_DICTIONARY = Object.freeze([
    // memcpy, MSVC 7.1
    entry({ name: 'memcpy', does: 'memmove', quick: '0a6ca4d87e404ebe', hash: 'db5be6e7b99cfa36',
        spans: [[0, 98], [261, 74], [353, 136], [728, 7], [757, 64]],
        masks: [[56, 4], [80, 4], [87, 4], [94, 4], [331, 4], [445, 4], [454, 4], [478, 4],
            [485, 4], [731, 4]] }),
    // memmove, MSVC 7.1
    entry({ name: 'memmove', does: 'memmove', quick: '0a6ca4d87e404ebe', hash: 'd4a68cbecbe642c8',
        spans: [[0, 98], [110, 105], [226, 106], [350, 136], [725, 7], [754, 64]],
        masks: [[56, 4], [80, 4], [87, 4], [94, 4], [147, 4], [182, 4], [211, 4], [226, 32],
            [328, 4], [442, 4], [451, 4], [475, 4], [482, 4], [728, 4]] }),
    // memset, MSVC 7.1
    entry({ name: 'memset', does: 'memset', quick: '285a339313734c2d', hash: '0488f3bcf759e52a',
        spans: [[0, 89]],
        masks: [[12, 4], [30, 4], [41, 4], [69, 4], [79, 4]] }),
    // strlen, MSVC 7.1
    entry({ name: 'strlen', does: 'strlen', quick: '721775d4ae73d116', hash: 'ddfebc10f34dba22',
        spans: [[0, 104]],
        masks: [[17, 4], [69, 4], [80, 4]] }),
    // sqrt, MSVC 7.1, MSVC 8
    entry({ name: 'sqrt', does: 'sqrt', quick: 'f737d75f53119de9', hash: '5ed76b363121c76f',
        spans: [[0, 166]],
        masks: [[5, 4], [29, 4], [44, 4], [51, 4], [62, 4], [67, 4], [95, 4], [126, 4], [137, 4],
            [144, 4], [155, 4], [160, 4]] }),
    // memmove, MSVC 8
    entry({ name: 'memmove', does: 'memmove', quick: '0a6ca4d87e404ebe', hash: '66a7853ed893e1d3',
        spans: [[0, 99], [100, 31], [132, 7], [296, 74], [388, 7], [396, 11], [408, 17],
            [428, 23], [452, 38], [492, 9], [504, 31], [775, 7], [800, 7], [808, 13], [824, 19],
            [844, 25]],
        masks: [[42, 4], [67, 4], [95, 4], [120, 4], [127, 4], [135, 4], [366, 4], [486, 4],
            [497, 4], [524, 4], [531, 4], [778, 4]] }),
    // memset, MSVC 8
    entry({ name: 'memset', does: 'memset', quick: 'd7ff0946071ad318', hash: '91ce263211c226e3',
        spans: [[0, 122]],
        masks: [[32, 4], [40, 4]] }),
    // strlen, MSVC 8, MSVC 10
    entry({ name: 'strlen', does: 'strlen', quick: '75a85fb2564572c0', hash: '9e64c004468cc0a5',
        spans: [[0, 139]],
        masks: [] }),
    // memmove, MSVC 10
    entry({ name: 'memmove', does: 'memmove', quick: '0a6ca4d87e404ebe', hash: '547d31fe7f1dfbb3',
        spans: [[0, 127], [128, 7], [292, 74], [384, 7], [392, 11], [404, 17], [424, 23],
            [448, 38], [488, 9], [500, 31], [771, 7], [796, 7], [804, 13], [820, 19], [840, 25]],
        masks: [[42, 4], [64, 4], [92, 4], [116, 4], [123, 4], [131, 4], [362, 4], [482, 4],
            [493, 4], [520, 4], [527, 4], [774, 4]] }),
    // memset, MSVC 10
    entry({ name: 'memset', does: 'memset', quick: 'd7ff0946071ad318', hash: 'd20795895fa21b64',
        spans: [[0, 122]],
        masks: [[32, 4], [40, 4]] }),
    // memmove, MSVC 14 (2015-2022)
    entry({ name: 'memmove', does: 'memmove', quick: 'b741676d64e258f3', hash: '2865095e2d686cd3',
        spans: [[0, 604], [628, 7], [636, 11], [648, 17], [668, 23], [692, 91], [800, 7],
            [808, 13], [824, 19], [844, 255], [1104, 231], [1344, 52]],
        masks: [[52, 4], [71, 4], [101, 4], [115, 4], [545, 4], [600, 4], [710, 4], [779, 4]] }),
    // memset, MSVC 14 (2015-2022)
    entry({ name: 'memset', does: 'memset', quick: 'b006565d53e1bf83', hash: 'bfb9b49d39ebf580',
        spans: [[0, 346]],
        masks: [[53, 4], [72, 4], [192, 4]] }),
    // memmove, MSVC 14 (2015-2022), x86-64
    entry({ name: 'memmove', does: 'memmove', bits: 64, quick: '39e6e8c6c2fe697c',
        hash: '50fc9466a6b2729f',
        spans: [[0, 47], [48, 63], [112, 63], [176, 111], [288, 93], [1088, 327], [1424, 65],
            [1504, 141]],
        masks: [[6, 4], [36, 4], [339, 4], [370, 4], [377, 4], [1099, 4], [1106, 4], [1295, 4]] }),
    // memset, MSVC 14 (2015-2022), x86-64
    entry({ name: 'memset', does: 'memset', bits: 64, quick: 'f4373e9821ac7a46',
        hash: 'dd13277e72560733',
        spans: [[0, 97], [112, 13], [128, 47], [176, 66], [688, 216]],
        masks: [[9, 4], [55, 4], [200, 4], [214, 4], [223, 4], [231, 4], [238, 4], [691, 4],
            [699, 4], [706, 4], [833, 4]] }),
    // _allmul, the compiler's own (llmath, chkstk): the same bytes in every MSVC
    entry({ name: '_allmul', does: 'allmul', quick: '6a7aea7d7ee17b9f', hash: '6cdd48c50a64c8cf',
        spans: [[0, 52]], masks: [] }),
    // _alldiv, the compiler's own (llmath, chkstk): the same bytes in every MSVC
    entry({ name: '_alldiv', does: 'alldiv', quick: 'debd877a5d0f1a64', hash: '44862b96d4fed26f',
        spans: [[0, 170]], masks: [] }),
    // _aulldiv, the compiler's own (llmath, chkstk): the same bytes in every MSVC
    entry({ name: '_aulldiv', does: 'aulldiv', quick: '494011f3c63bab11', hash: '98fd2d2a8ce9bae4',
        spans: [[0, 104]], masks: [] }),
    // _allrem, the compiler's own (llmath, chkstk): the same bytes in every MSVC
    entry({ name: '_allrem', does: 'allrem', quick: 'f745af7026587992', hash: '8f74775b885aa79a',
        spans: [[0, 178]], masks: [] }),
    // _aullrem, the compiler's own (llmath, chkstk): the same bytes in every MSVC
    entry({ name: '_aullrem', does: 'aullrem', quick: 'ee492fe72d2a8af9', hash: '53d0c154e6ff1fe6',
        spans: [[0, 117]], masks: [] }),
    // _aulldvrm, the compiler's own (llmath, chkstk): the same bytes in every MSVC
    entry({ name: '_aulldvrm', does: 'aulldvrm', quick: 'ea1964766b95b0e0',
        hash: 'b6f2a5c54a2bd56b',
        spans: [[0, 149]], masks: [] }),
    // _allshl, the compiler's own (llmath, chkstk): the same bytes in every MSVC
    entry({ name: '_allshl', does: 'allshl', quick: 'e6e5c5625172b434', hash: 'f49df3c499cfde89',
        spans: [[0, 31]], masks: [] }),
    // _aullshr, the compiler's own (llmath, chkstk): the same bytes in every MSVC
    entry({ name: '_aullshr', does: 'aullshr', quick: '81ff8022303fd6b8', hash: 'eb1328766c511cf7',
        spans: [[0, 31]], masks: [] }),
    // _chkstk, the compiler's own (llmath, chkstk): the same bytes in every MSVC
    entry({ name: '_chkstk', does: 'chkstk', quick: '27a7f2a3bdb1d9c9', hash: 'dfe28e9509ed3a48',
        spans: [[0, 43]], masks: [] }),
    // _allshr, the compiler's own (llmath, chkstk): the same bytes in every MSVC
    entry({ name: '_allshr', does: 'allshr', quick: '95d4a299b46ad05f', hash: '0ad55242ad9d7388',
        spans: [[0, 33]], masks: [] }),
    // floor, MSVC 7.1
    entry({ name: 'floor', does: 'floor', quick: '2321354bdf2f6e59', hash: 'e505cb340ab6f745',
        spans: [[0, 287]],
        masks: [[2, 4], [9, 4], [58, 4], [72, 4], [97, 4], [180, 4], [229, 4], [255, 4], [264, 4],
            [272, 4]] }),
    // ceil, MSVC 7.1
    entry({ name: 'ceil', does: 'ceil', quick: '2321354bdf2f6e59', hash: '88842ed3d6e1a9da',
        spans: [[0, 283]],
        masks: [[2, 4], [9, 4], [58, 4], [72, 4], [97, 4], [180, 4], [229, 4], [250, 4], [259, 4],
            [268, 4]] }),
    // floor, MSVC 8
    entry({ name: 'floor', does: 'floor', quick: '2321354bdf2f6e59', hash: '2b61b9f2e37ddde0',
        spans: [[0, 289]],
        masks: [[2, 4], [9, 4], [58, 4], [74, 4], [99, 4], [182, 4], [231, 4], [257, 4], [266, 4],
            [274, 4]] }),
    // ceil, MSVC 8
    entry({ name: 'ceil', does: 'ceil', quick: '2321354bdf2f6e59', hash: '625102f994c32f57',
        spans: [[0, 285]],
        masks: [[2, 4], [9, 4], [58, 4], [74, 4], [99, 4], [182, 4], [231, 4], [252, 4], [261, 4],
            [270, 4]] }),
    // floor, MSVC 10
    entry({ name: 'floor', does: 'floor', quick: '2321354bdf2f6e59', hash: '7f72235226afa980',
        spans: [[0, 289]],
        masks: [[2, 4], [9, 4], [58, 4], [74, 4], [99, 4], [182, 4], [231, 4], [257, 4], [266, 4],
            [274, 4]] }),
    // ceil, MSVC 10
    entry({ name: 'ceil', does: 'ceil', quick: '2321354bdf2f6e59', hash: 'fbed3019a6e15c77',
        spans: [[0, 285]],
        masks: [[2, 4], [9, 4], [58, 4], [74, 4], [99, 4], [182, 4], [231, 4], [252, 4], [261, 4],
            [270, 4]] }),
]);
