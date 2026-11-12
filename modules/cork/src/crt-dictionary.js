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
 * `_ftol2_sse`'s own way with the runtime's SSE2 flag set: ST0 stored as a
 * double, popped, and truncated to eax by `cvttsd2si` (0x80000000 past an
 * int's range or for a NaN); edx as it was.
 */
const FTOL2_SSE_BODY = Object.freeze([
    0xdd, 0x5c, 0x24, 0xf8,                 // fstp qword [esp-8]
    0xf2, 0x0f, 0x2c, 0x44, 0x24, 0xf8,     // cvttsd2si eax, qword [esp-8]
]);

/** The x87 transcendentals' argument put where their test reads it (`lead`): ST0 at [esp-8]. */
const X87_LEAD = Object.freeze([0xdd, 0x54, 0x24, 0xf8]);   // fst qword [esp-8]
/** And ST1 at [esp-16], for _CIpow. */
const X87_LEAD2 = Object.freeze([0xdd, 0x54, 0x24, 0xf8, 0xd9, 0xc9,  // fst [esp-8]; fxch
    0xdd, 0x54, 0x24, 0xf0, 0xd9, 0xc9]);                            // fst [esp-16]; fxch

/**
 * The transcendentals' bodies: the host's result, put at [esp-8] by the test
 * (`emit/crt.js`), loaded in the argument's place -- `fstp st0; fld [esp-8]`,
 * pow's two arguments popped first.
 */
const HOST_RESULT = [0xdd, 0xd8, 0xdd, 0x44, 0x24, 0xf8];
const CI_BODIES = Object.freeze({
    cisin: HOST_RESULT, cicos: HOST_RESULT, citan: HOST_RESULT, ciatan: HOST_RESULT,
    ciasin: HOST_RESULT, ciacos: HOST_RESULT, cilog: HOST_RESULT, cilog10: HOST_RESULT,
    ciexp: HOST_RESULT, cipow: [0xdd, 0xd8, ...HOST_RESULT],
});

/**
 * The second signature of a stub told by where it jumps (`via`): the code
 * `offset` bytes past where its rel32 at `at` leads.
 *
 * @param {number} at @param {number} offset
 * @param {{ name: string, quick: string, hash: string, spans: number[][],
 *     masks: number[][] }} given
 */
function viaJump(at, offset, given){
    return Object.freeze({ ...entry({ ...given, does: 'cisin' }), at, offset });
}

/**
 * The body a call to a function doing `does` goes on with after its test
 * (`emit/crt.js`), for the operations that have one.
 *
 * @type {Readonly<Partial<Record<import('./helpers.js').Crt, readonly number[]>>>}
 */
export const CRT_BODIES = Object.freeze({
    sqrt: SQRT_BODY, floor: roundBody(1), ceil: roundBody(2), ftol2sse: FTOL2_SSE_BODY,
    ...CI_BODIES,
});

/**
 * An entry: its masks given as runs `[offset, length]`, its length from its
 * spans.
 *
 * @param {{ name: string, does: import('./helpers.js').Crt, quick: string, hash: string,
 *     body?: readonly number[], spans: number[][], masks: number[][], bits?: 32 | 64,
 *     word?: number, wordRip?: boolean, shape?: boolean, lead?: readonly number[],
 *     via?: RuntimeHelper & { at: number, offset?: number } }} given
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

/**
 * The SSE2 code the `_CI*` stubs jump to (`via`), by function: Visual C++ 8
 * and 10 share all but `sin` and `cos`.
 */
const SIN_VC8 = { name: '_sin_pentium4', quick: 'd51167b0009625aa',
    hash: '3f299c663f560aa3',
    spans: [[0, 431]],
    masks:
            [[33, 4], [45, 4], [61, 4], [73, 4], [102, 4], [108, 4], [129, 4],
                [166, 4], [235, 4], [247, 4], [370, 4], [392, 4], [408, 4], [427, 4]] };
const COS_VC8 = { name: '_cos_pentium4', quick: 'd51167b0009625aa',
    hash: '90c0e442521fa388',
    spans: [[0, 401]],
    masks:
            [[33, 4], [45, 4], [61, 4], [73, 4], [102, 4], [108, 4], [129, 4],
                [166, 4], [235, 4], [247, 4], [374, 4], [397, 4]] };
const TAN = { name: '_tan_pentium4', quick: 'd51167b0009625aa',
    hash: '2d4059bdaf930b0c',
    spans: [[0, 570]],
    masks:
            [[37, 4], [53, 4], [65, 4], [77, 4], [91, 4], [122, 4], [149, 4],
                [158, 4], [166, 4], [403, 4], [523, 4], [531, 4], [547, 4], [566, 4]] };
const ATAN = { name: '_atan_pentium4', quick: 'd7e0fabc2f9fab26',
    hash: 'a92f450864621509',
    spans: [[0, 723]],
    masks:
            [[18, 4], [26, 4], [46, 4], [56, 4], [86, 4], [98, 4], [110, 4],
                [122, 4], [166, 4], [196, 4], [208, 4], [220, 4], [232, 4], [244, 4],
                [256, 4], [268, 4], [280, 4], [332, 4], [342, 4], [350, 4], [383, 4],
                [403, 4], [430, 4], [447, 4], [456, 4], [480, 4], [492, 4], [504, 4],
                [516, 4], [572, 4], [587, 4], [595, 4], [601, 4], [624, 4], [630, 4],
                [647, 4], [670, 4], [677, 4], [711, 4]] };
const ASIN = { name: '_asin_pentium4', quick: '1217aadf5e4d18c1',
    hash: 'cfc1c8fe5fb764b0',
    spans: [[0, 1384]],
    masks:
            [[10, 4], [18, 4], [30, 4], [124, 4], [137, 4], [181, 4], [189, 4],
                [224, 4], [333, 4], [350, 4], [413, 4], [425, 4], [457, 4], [473, 4],
                [485, 4], [494, 4], [609, 4], [621, 4], [629, 4], [742, 4], [755, 4],
                [767, 4], [827, 4], [874, 4], [882, 4], [890, 4], [943, 4], [1212, 4],
                [1246, 4], [1254, 4], [1262, 4]] };
const ACOS = { name: '_acos_pentium4', quick: '1217aadf5e4d18c1',
    hash: '9848453cb454806a',
    spans: [[0, 1340]],
    masks:
            [[10, 4], [18, 4], [30, 4], [124, 4], [137, 4], [181, 4], [189, 4],
                [224, 4], [251, 4], [428, 4], [452, 4], [472, 4], [488, 4], [500, 4],
                [509, 4], [641, 4], [653, 4], [661, 4], [673, 4], [799, 4], [807, 4],
                [815, 4], [827, 4], [839, 4], [878, 4], [912, 4], [1191, 4],
                [1244, 4], [1252, 4], [1289, 4], [1297, 4]] };
const LOG = { name: '_log_pentium4', quick: 'f52a450f289c314d',
    hash: '1603149349ca5469',
    spans: [[0, 596]],
    masks:
            [[33, 4], [41, 4], [49, 4], [57, 4], [87, 4], [95, 4], [193, 4],
                [205, 4], [225, 4], [237, 4], [249, 4], [336, 4], [378, 4], [386, 4],
                [415, 4], [431, 4], [443, 4], [458, 4], [539, 4]] };
const LOG10 = { name: '_log10_pentium4', quick: 'f52a450f289c314d',
    hash: 'a96c61180da6b486',
    spans: [[0, 620]],
    masks:
            [[33, 4], [41, 4], [49, 4], [57, 4], [65, 4], [95, 4], [103, 4],
                [201, 4], [213, 4], [233, 4], [245, 4], [257, 4], [289, 4], [360, 4],
                [402, 4], [410, 4], [439, 4], [455, 4], [467, 4], [482, 4], [563, 4]] };
const SIN_VC10 = { name: '_sin_pentium4', quick: 'd51167b0009625aa',
    hash: 'daba3aaa8ec1885f',
    spans: [[0, 431]],
    masks:
        [[33, 4], [45, 4], [61, 4], [73, 4], [102, 4], [108, 4], [129, 4],
            [166, 4], [235, 4], [247, 4], [370, 4], [392, 4], [408, 4], [427, 4]] };
const COS_VC10 = { name: '_cos_pentium4', quick: 'd51167b0009625aa',
    hash: 'd481ce065e927a6c',
    spans: [[0, 401]],
    masks:
        [[33, 4], [45, 4], [61, 4], [73, 4], [102, 4], [108, 4], [129, 4],
            [166, 4], [235, 4], [247, 4], [374, 4], [397, 4]] };

/**
 * A runtime's `_CI*` stubs of one argument: alike to the byte (its `hash`) but
 * for where they jump, each told by the SSE2 code that jump leads to.
 *
 * @param {string} hash  the stubs' own
 * @param {Record<string, any>} cores  the SSE2 code, by operation
 */
function ciStubs(hash, cores){
    return Object.entries(cores).map(([does, core])=>entry({
        name: `_CI${does.slice(2)}`, does: /** @type {import('./helpers.js').Crt} */ (does),
        lead: X87_LEAD, quick: 'a94bd8e5df22f6e3', hash, spans: [[0, 79]],
        masks: [[2, 4], [55, 4], [66, 4]], via: viaJump(55, 24, core) }));
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
    // __chkstk, the compiler's own (chkstk.obj), x86-64: the same bytes in every image seen
    entry({ name: '__chkstk', does: 'chkstk64', bits: 64, quick: '7d8c83bf6e534bd5',
        hash: '3166d08ff8ebcc9e', spans: [[0, 78]], masks: [] }),
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
    // memcmp, strcmp, memchr and strchr: the bytes compared or searched in order, -1, 0 or
    // 1 the comparisons' answer, the byte's address or 0 the searches'.
    // memcmp, MSVC 7.1
    entry({ name: 'memcmp', does: 'memcmp', quick: '7e912cf20524b1a0', hash: 'f0b018c261345d54',
        spans: [[0, 184]], masks: [] }),
    // strcmp, MSVC 7.1
    entry({ name: 'strcmp', does: 'strcmp', quick: 'c752d729f18891e3', hash: '9069088de8c503cc',
        spans: [[0, 135]], masks: [] }),
    // memchr, MSVC 7.1
    entry({ name: 'memchr', does: 'memchr', quick: '4285aa4bc72270ed', hash: '166e2970f41391ad',
        spans: [[0, 171]], masks: [] }),
    // strchr, MSVC 7.1, 8 and 10
    entry({ name: 'strchr', does: 'strchr', quick: '8922dff0b20c61de', hash: '8b67473fc82f9232',
        spans: [[0, 190]], masks: [[29, 4]] }),
    // memcmp, MSVC 8
    entry({ name: 'memcmp', does: 'memcmp', quick: '206aa105233e00a7', hash: '362944264f6813ef',
        spans: [[0, 5630]], masks: [[1224, 4]] }),
    // strcmp, MSVC 8 and 10
    entry({ name: 'strcmp', does: 'strcmp', quick: 'c852d8bcf68899c2', hash: '64c3b0050f175260',
        spans: [[0, 67], [68, 68]], masks: [] }),
    // memchr, MSVC 8, 10 and 14 (2015-2022)
    entry({ name: 'memchr', does: 'memchr', quick: '4285aa4bc72270ed', hash: 'b111a89309e667f5',
        spans: [[0, 173]], masks: [] }),
    // memcmp, MSVC 10
    entry({ name: 'memcmp', does: 'memcmp', quick: '942807945a748a0e', hash: '83a7f3ba0e137153',
        spans: [[0, 272], [416, 11], [433, 4]],
        masks: [[24, 4], [31, 4], [38, 4], [45, 4], [73, 4], [95, 4], [117, 4], [139, 4],
            [161, 4], [183, 4], [205, 4], [227, 4], [268, 4]] }),
    // memcmp, MSVC 14 (2015-2022)
    entry({ name: 'memcmp', does: 'memcmp', quick: '1c64830bf8b6ec0d', hash: '9e94be08da26a872',
        spans: [[0, 4929]], masks: [[1092, 4]] }),
    // strchr, MSVC 14 (2015-2022)
    entry({ name: 'strchr', does: 'strchr', quick: 'f4ae34772f35b6a5', hash: 'ac3265b3112c9a62',
        spans: [[0, 299]], masks: [[2, 4]] }),
    // memcmp, MSVC 14 (2015-2022), x86-64
    entry({ name: 'memcmp', does: 'memcmp', bits: 64, quick: 'cf517f1fd43d9441',
        hash: 'e26cdbce219a6b23', spans: [[0, 73], [74, 125]], masks: [] }),
    // memchr, MSVC 14 (2015-2022), x86-64
    entry({ name: 'memchr', does: 'memchr', bits: 64, quick: '128fd291afd3a53f',
        hash: '361b2fe75f9d0f55', spans: [[0, 144]], masks: [] }),
    // strchr, MSVC 14 (2015-2022), x86-64
    entry({ name: 'strchr', does: 'strchr', bits: 64, quick: '3984ba71f976343b',
        hash: 'b90c34bebd4489c7', spans: [[0, 126]], masks: [] }),
    // _ftol2_sse, the compiler's own (ftol2.obj), MSVC 8 to 10 alike (Call of Duty 4's,
    // 3DMark 11's): with the runtime's __sse2_available (`word`) set, ST0 truncated by
    // cvttsd2si; else its _ftol2, made as the call was.
    entry({ name: '_ftol2_sse', does: 'ftol2sse', word: 2, quick: 'b06f592c2e902cee',
        hash: '643f053f63789de9', spans: [[0, 28], [54, 117]], masks: [[2, 4]] }),
    // __security_check_cookie (gs_report.obj), as every function a /GS build guards with a
    // buffer calls it on its way out: ecx against the runtime's cookie (`word`), a return
    // when equal, else a jump to the report (masked). Its own bytes are too few for a
    // signature, and the shape is the operation: what these bytes do whatever the cookie's
    // address and the report's (`shape`). MSVC 8 to 14 (`rep ret`, 130 images here: Call
    // of Duty 4, its Miles and Bink libraries) and MSVC 7.1 (`ret`, 21: PhysX, Miles' filters).
    entry({ name: '__security_check_cookie', does: 'gscookie', word: 2, shape: true,
        quick: '765e53d60506e257', hash: '765e53d60506e257', spans: [[0, 15]],
        masks: [[2, 4], [11, 4]] }),
    entry({ name: '__security_check_cookie', does: 'gscookie', word: 2, shape: true,
        quick: 'ee0754fe65c7d77b', hash: 'ee0754fe65c7d77b', spans: [[0, 14]],
        masks: [[2, 4], [10, 4]] }),
    // __security_check_cookie, x86-64, MSVC 14: rcx against the cookie (`word`, RIP-relative),
    // its high 16 bits clear, returned rotated left by 16 as the function leaves it.
    entry({ name: '__security_check_cookie', does: 'gscookie64', bits: 64, word: 3,
        wordRip: true, shape: true, quick: 'b05eca804d551dc2', hash: 'd413b6519e3eebc8',
        spans: [[0, 30]], masks: [[3, 4], [26, 4]] }),
    // The x87 transcendentals MSVC 8 and 10 link into an image (`_CIsin` and kin): ST0's
    // (and _CIpow's ST1) value taken by the host's own functions, where the runtime's SSE2
    // path would round differently by the last bit at most (`lead`, `body`,
    // roadmap/decisions.md). PhysX 2.7-2.8's PhysXCore.dll and Call of Duty 4's iw3sp.exe
    // link Visual C++ 8's.
    ...ciStubs('45863a1a223a40e7', { cisin: SIN_VC8, cicos: COS_VC8, citan: TAN, ciatan: ATAN,
        ciasin: ASIN, ciacos: ACOS, cilog: LOG, cilog10: LOG10 }),
    ...ciStubs('9ea4bc7ae8223fc7', { cisin: SIN_VC10, cicos: COS_VC10, citan: TAN,
        ciatan: ATAN, ciasin: ASIN, ciacos: ACOS, cilog: LOG, cilog10: LOG10 }),
    entry({ name: '_CIexp', does: 'ciexp', lead: X87_LEAD, quick: 'f1454e170f6c75b1',
        hash: '4136b43b4b7607e1', spans: [[0, 59], [69, 10]],
        masks: [[2, 4], [55, 4], [70, 4], [75, 4]] }),
    entry({ name: '_CIexp', does: 'ciexp', lead: X87_LEAD, quick: 'f1454e170f6c75b1',
        hash: '4ca067765e9ba5d3', spans: [[0, 59], [69, 10], [226, 61]],
        masks: [[2, 4], [55, 4], [70, 4], [245, 4], [253, 4]] }),
    entry({ name: '_CIpow', does: 'cipow', lead: X87_LEAD2, quick: 'a94bd8e5df22f6e3',
        hash: 'a7e7bff9eb2f7b33', spans: [[0, 84]], masks: [[2, 4], [55, 4]] }),
    entry({ name: '_CIpow', does: 'cipow', lead: X87_LEAD2, quick: 'a94bd8e5df22f6e3',
        hash: '8283acd9b02e7c93', spans: [[0, 84]], masks: [[2, 4], [55, 4]] }),
]);
