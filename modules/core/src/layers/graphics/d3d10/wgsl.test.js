/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the translator writes for each instruction, pinned as text.
 *
 * WGSL cannot be compiled here -- there is no GPU under the test runner -- so
 * what these prove is that a given instruction becomes a given expression, and
 * that the expression is the one the semantics call for: a float add is a
 * bitcast around `+`, a comparison is all-ones-or-zero, a partial write mask
 * is a component-wise store through a `let`. Whether the browser's compiler
 * accepts the whole is a question only a browser can answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENT_TYPE, SHADER_KIND, SYSTEM_VALUE, parseDxbc } from './dxbc.js';
import { MODIFIER, RESOURCE_DIMENSION, RETURN_TYPE, SAMPLER_MODE } from './sm4.js';
import {
    BINDING, BUFFER_VIEW_FORMATS, HELPERS, NO_PIXEL_SHADER, STAGE, linkCompute, linkProgram,
    translateShader,
} from './wgsl.js';
import { DXGI_FORMAT } from './constants.js';
import {
    add, addSat, and, assemble, breakOut, breakcNz, call, callcNz, caseOf, cb,
    colouredPixelShader, colouredVertexShader, defaultCase, endswitch, label, switchOn,
    dclConstantBuffer, dclIndexableTemp, dclInput, dclInputPs, dclInputPsSiv, dclInputSiv,
    dclOutput, dclOutputSiv, dclResource, dclSampler, dclTemps, discardNz, div, dp3, dp4,
    elseBranch, endif, endloop, eq, exp, frc, ftoi, ftou, gather4, ge, iadd, ieq, ifNz, ifZ, ige,
    ilt, imad, ldMs, resinfoRcp, sampleD, gather4C, gather4Po,
    imul,
    immediateConstantBuffer, indexedBy, ineg, ishl, ishr, itof, l, ld, log, loop, lt, lu, mad, max,
    min, modified, mov, movc, mul, ne, not, nullDest, o, oDepth, or, passThroughVertexShader,
    rasterizer, sampleInfo, samplePos, dclInputPsSgv, lod, evalCentroid, evalSampleIndex,
    evalSnapped, dclFunctionBody, dclFunctionTable, dclInterface, fcall, functionBody,
    thisPointer, dadd, dmul, dfma, drcp, dmovc, dmax, dmov, dl, deq, dge, dne, dlt, dtof, dtoi,
    dtou, ftod, itod, utod,
    r, resinfo, ret, retcNz, roundNe, roundNi, rsq, s, sample, sampleCLz, sampleL, sincos,
    solidPixelShader, sqrt, t, udiv, ult, umax, umin, umul, ushr, utof, v, xor,
    atomicIadd, dclGlobalFlags, dclIndexRange, oMask, vCoverage, dclUavTyped, ldUavTyped,
    storeUavTyped,
    dclThreadGroup,
    dclTgsmRaw, dclUavRaw, dclUavStructured, g, immAtomicImax, ldRaw,
    storeRaw, storeStructured, sync, u, vThreadID, vThreadIDInGroupFlattened,
} from './shader-fixtures.js';

/**
 * A pixel shader body around the given instructions, translated. The
 * declarations a body needs -- temps, an output -- are added so a test names
 * only the instruction it is about.
 *
 * @param {(import('./shader-fixtures.js').AsmInstruction | { customData: number[] })[]} body
 * @param {object} [more]
 * @param {(import('./shader-fixtures.js').AsmInstruction | { customData: number[] })[]}
 *        [more.declarations]
 * @param {number} [more.kind]
 * @param {Parameters<typeof translateShader>[1]} [more.options]  the translation's
 */
function translate(body, more = {}){
    const parsed = parseDxbc(assemble({
        kind: more.kind ?? SHADER_KIND.PIXEL,
        inputs: [{ name: 'TEXCOORD', register: 0 }, { name: 'TEXCOORD', index: 1, register: 1 }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [
            dclInputPs(v(0)), dclInputPs(v(1)), dclOutput(o(0)), dclTemps(4),
            ...(more.declarations ?? []),
            ...body,
            ret(),
        ],
    }));
    assert.ok(parsed);
    return translateShader(parsed, more.options);
}

/**
 * The body as one string, with the return every shader ends on left off.
 *
 * @param {ReturnType<typeof translate>} translated @returns {string}
 */
const bodyOf = translated=>translated.body
    .map(line=>(typeof line === 'string' ? line.trim() : 'RET'))
    .join('\n')
    .replace(/\nRET$/, '');

/** @param {(import('./shader-fixtures.js').AsmInstruction)[]} body @returns {string} */
const emitted = body=>bodyOf(translate(body));

const F = 'bitcast<vec4<f32>>';
const I = 'bitcast<vec4<i32>>';
const U = 'bitcast<vec4<u32>>';

// --- moves and stores ---

test('mov copies bit patterns without a type', ()=>{
    assert.equal(emitted([mov(r(0), v(1, 'wzyx'))]), 'r0 = v1.wzyx;');
});

test('a partial write mask stores through a let, one component at a time', ()=>{
    assert.equal(emitted([mov(r(0, 'xy'), r(0, 'yx'))]),
        'let held0 = r0.yxxx;\nr0.x = held0.x;\nr0.y = held0.y;');
});

test('a saturated move clamps as floats', ()=>{
    assert.equal(bodyOf(translate([{ ...mov(r(0), r(1)), saturate: true }])),
        `r0 = ${U}(clamp(${F}(r1.xyzw), vec4<f32>(0.0), vec4<f32>(1.0)));`);
});

test('movc selects per component on a non-zero first source', ()=>{
    assert.equal(emitted([movc(r(0), r(1), r(2), r(3))]),
        'r0 = select(r3.xyzw, r2.xyzw, r1.xyzw != vec4<u32>(0u));');
});

test('an immediate is spelled as its dwords, replicated when scalar', ()=>{
    assert.equal(emitted([mov(r(0), l(1, 0, 0.5, -2))]),
        'r0 = vec4<u32>(1065353216u, 0u, 1056964608u, 3221225472u);');
    assert.equal(emitted([mov(r(0), lu(9))]), 'r0 = vec4<u32>(9u);');
});

// --- float arithmetic ---

test('float arithmetic reads floats and writes bits back', ()=>{
    assert.equal(emitted([add(r(0), r(1), r(2))]),
        `r0 = ${U}((${F}(r1.xyzw) + ${F}(r2.xyzw)));`);
    assert.equal(emitted([mul(r(0), r(1), l(2, 2, 2, 2))]),
        `r0 = ${U}((${F}(r1.xyzw) * ${F}(vec4<u32>(1073741824u, 1073741824u,`
        + ' 1073741824u, 1073741824u))));');
    assert.equal(emitted([mad(r(0), r(1), r(2), r(3))]),
        `r0 = ${U}((${F}(r1.xyzw) * ${F}(r2.xyzw) + ${F}(r3.xyzw)));`);
    assert.equal(emitted([div(r(0), r(1), r(2))]),
        `r0 = ${U}((${F}(r1.xyzw) / ${F}(r2.xyzw)));`);
    assert.equal(emitted([min(r(0), r(1), r(2))]),
        `r0 = ${U}(min(${F}(r1.xyzw), ${F}(r2.xyzw)));`);
    assert.equal(emitted([max(r(0), r(1), r(2))]),
        `r0 = ${U}(max(${F}(r1.xyzw), ${F}(r2.xyzw)));`);
});

test('saturate wraps the float result in a clamp', ()=>{
    assert.equal(emitted([addSat(r(0), r(1), r(2))]),
        `r0 = ${U}(clamp((${F}(r1.xyzw) + ${F}(r2.xyzw)), vec4<f32>(0.0), vec4<f32>(1.0)));`);
});

test('a dot product takes as many components as its width and splats the scalar', ()=>{
    assert.equal(emitted([dp3(r(0, 'x'), r(1), r(2))]),
        `let held0 = ${U}(vec4<f32>(dot(${F}(r1.xyzw).xyz, ${F}(r2.xyzw).xyz)));\nr0.x = held0.x;`);
    assert.equal(emitted([dp4(r(0), r(1), cb(0, 3))]),
        `r0 = ${U}(vec4<f32>(dot(${F}(r1.xyzw), ${F}(cb0[3u].xyzw))));`);
});

test('the unary float functions map one to one', ()=>{
    assert.equal(emitted([rsq(r(0), r(1))]), `r0 = ${U}(inverseSqrt(${F}(r1.xyzw)));`);
    assert.equal(emitted([sqrt(r(0), r(1))]), `r0 = ${U}(sqrt(${F}(r1.xyzw)));`);
    assert.equal(emitted([frc(r(0), r(1))]), `r0 = ${U}(fract(${F}(r1.xyzw)));`);
    assert.equal(emitted([exp(r(0), r(1))]), `r0 = ${U}(exp2(${F}(r1.xyzw)));`);
    assert.equal(emitted([log(r(0), r(1))]), `r0 = ${U}(log2(${F}(r1.xyzw)));`);
    assert.equal(emitted([roundNe(r(0), r(1))]), `r0 = ${U}(round(${F}(r1.xyzw)));`);
    assert.equal(emitted([roundNi(r(0), r(1))]), `r0 = ${U}(floor(${F}(r1.xyzw)));`);
});

test('sincos writes the sine and the cosine to its two destinations', ()=>{
    assert.equal(emitted([sincos(r(0), r(1), r(2))]),
        `let held0 = ${U}(cos(${F}(r2.xyzw)));\nr0 = ${U}(sin(${F}(r2.xyzw)));\nr1 = held0;`);
    assert.equal(emitted([sincos(r(2), r(1), r(2))]),
        `let held0 = ${U}(cos(${F}(r2.xyzw)));\nr2 = ${U}(sin(${F}(r2.xyzw)));\nr1 = held0;`,
        'the cosine is of the source as it was, not of the sine written over it');
    assert.equal(emitted([sincos(nullDest(), r(1), r(2))]),
        `r1 = ${U}(cos(${F}(r2.xyzw)));`, 'a null destination is not stored');
});

test('a modifier negates or takes the absolute value of the typed read', ()=>{
    assert.equal(emitted([add(r(0), modified(r(1), MODIFIER.NEG), modified(r(2), MODIFIER.ABS))]),
        `r0 = ${U}(((-${F}(r1.xyzw)) + abs(${F}(r2.xyzw))));`);
    // A move with a source modifier is a float's: WGSL negates no unsigned vector.
    assert.equal(emitted([mov(r(0), modified(r(1), MODIFIER.ABSNEG))]),
        'r0 = bitcast<vec4<u32>>((-abs(bitcast<vec4<f32>>(r1.xyzw))));');
    assert.equal(emitted([ineg(r(0), modified(r(1), MODIFIER.NEG))]).includes('(-'), true);
});

// --- comparisons ---

test('a comparison is all ones or all zeros per component', ()=>{
    const mask = 'select(vec4<u32>(0u), vec4<u32>(0xffffffffu), ';
    assert.equal(emitted([lt(r(0), r(1), r(2))]),
        `r0 = ${mask}(${F}(r1.xyzw) < ${F}(r2.xyzw)));`);
    assert.equal(emitted([ge(r(0), r(1), r(2))]),
        `r0 = ${mask}(${F}(r1.xyzw) >= ${F}(r2.xyzw)));`);
    assert.equal(emitted([eq(r(0), r(1), r(2))]),
        `r0 = ${mask}(${F}(r1.xyzw) == ${F}(r2.xyzw)));`);
    assert.equal(emitted([ne(r(0), r(1), r(2))]),
        `r0 = ${mask}(${F}(r1.xyzw) != ${F}(r2.xyzw)));`);
    assert.equal(emitted([ieq(r(0), r(1), r(2))]),
        `r0 = ${mask}(${I}(r1.xyzw) == ${I}(r2.xyzw)));`);
    assert.equal(emitted([ilt(r(0), r(1), r(2))]),
        `r0 = ${mask}(${I}(r1.xyzw) < ${I}(r2.xyzw)));`);
    assert.equal(emitted([ige(r(0), r(1), r(2))]),
        `r0 = ${mask}(${I}(r1.xyzw) >= ${I}(r2.xyzw)));`);
    assert.equal(emitted([ult(r(0), r(1), r(2))]),
        `r0 = ${mask}(r1.xyzw < r2.xyzw));`);
});

// --- integers ---

test('integer arithmetic reads and writes through the signed bitcast', ()=>{
    assert.equal(emitted([iadd(r(0), r(1), r(2))]), `r0 = ${U}((${I}(r1.xyzw) + ${I}(r2.xyzw)));`);
    assert.equal(emitted([imad(r(0), r(1), r(2), r(3))]),
        `r0 = ${U}((${I}(r1.xyzw) * ${I}(r2.xyzw) + ${I}(r3.xyzw)));`);
    assert.equal(emitted([ineg(r(0), r(1))]), `r0 = ${U}((-${I}(r1.xyzw)));`);
    assert.equal(emitted([itof(r(0), r(1))]), `r0 = ${U}(vec4<f32>(${I}(r1.xyzw)));`);
    assert.equal(emitted([utof(r(0), r(1))]), `r0 = ${U}(vec4<f32>(r1.xyzw));`);
    // Saturated to the type's top, which WGSL's conversion stops short of.
    assert.equal(emitted([ftoi(r(0), r(1))]), `let held0 = ${F}(r1.xyzw);\n`
        + `r0 = ${U}(select(vec4<i32>(held0), vec4<i32>(2147483647),`
        + ' held0 >= vec4<f32>(2147483648.0)));');
    assert.equal(emitted([ftou(r(0), r(1))]), `let held0 = ${F}(r1.xyzw);\n`
        + 'r0 = select(vec4<u32>(held0), vec4<u32>(0xffffffffu),'
        + ' held0 >= vec4<f32>(4294967296.0));');
    assert.equal(emitted([umin(r(0), r(1), r(2))]), 'r0 = min(r1.xyzw, r2.xyzw);');
    assert.equal(emitted([umax(r(0), r(1), r(2))]), 'r0 = max(r1.xyzw, r2.xyzw);');
});

test('bitwise operations and shifts stay unsigned, with the shift count masked', ()=>{
    assert.equal(emitted([and(r(0), r(1), r(2))]), 'r0 = (r1.xyzw & r2.xyzw);');
    assert.equal(emitted([or(r(0), r(1), r(2))]), 'r0 = (r1.xyzw | r2.xyzw);');
    assert.equal(emitted([xor(r(0), r(1), r(2))]), 'r0 = (r1.xyzw ^ r2.xyzw);');
    assert.equal(emitted([not(r(0), r(1))]), 'r0 = (~r1.xyzw);');
    assert.equal(emitted([ishl(r(0), r(1), r(2))]),
        'r0 = (r1.xyzw << (r2.xyzw & vec4<u32>(31u)));');
    assert.equal(emitted([ushr(r(0), r(1), r(2))]),
        'r0 = (r1.xyzw >> (r2.xyzw & vec4<u32>(31u)));');
    assert.equal(emitted([ishr(r(0), r(1), r(2))]),
        `r0 = ${U}((${I}(r1.xyzw) >> (r2.xyzw & vec4<u32>(31u))));`);
});

test('imul and umul write the high half of the product beside the low one', ()=>{
    assert.equal(emitted([imul(nullDest(), r(0), r(1), r(2))]),
        `r0 = ${U}((${I}(r1.xyzw) * ${I}(r2.xyzw)));`);
    const signed = translate([imul(r(3), r(0), r(1), r(2))]);
    assert.equal(bodyOf(signed), [
        `let held0 = ${U}((${I}(r1.xyzw) * ${I}(r2.xyzw)));`,
        `r3 = imulhi(${U}(${I}(r1.xyzw)), ${U}(${I}(r2.xyzw)));`,
        'r0 = held0;',
    ].join('\n'));
    assert.deepEqual(signed.unsupported, []);
    assert.deepEqual(signed.helpers, ['umulhi', 'imulhi'], 'the helper and what it calls');
    const unsigned = translate([umul(r(3), nullDest(), r(1), r(2))]);
    assert.equal(bodyOf(unsigned), 'r3 = umulhi(r1.xyzw, r2.xyzw);');
    assert.deepEqual(unsigned.helpers, ['umulhi']);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const fragment = linkProgram(vs, signed).fragment;
    assert.ok(fragment.indexOf('fn umulhi(') < fragment.indexOf('fn imulhi('),
        'written into the module, callee first');
    assert.ok(!linkProgram(vs, translate([mov(r(0), r(1))])).fragment.includes('fn umulhi'));
});

test('the high halves the helpers compute are the high halves of the products', ()=>{
    // The helpers' WGSL, read one lane at a time: every operation in them is
    // one JavaScript has on unsigned 32-bit values once >> is read as >>>.
    const source = [...HELPERS.umulhi.text, ...HELPERS.imulhi.text].join('\n')
        .replace(/fn (\w+)\(a: [^)]*\) -> [^{]*\{/g, 'function $1(a, b) {')
        .replace(/vec4<u32>\(([^()]*)\)/g, '($1)')
        .replace(/(0x[0-9a-f]+|\d+)u\b/g, '$1')
        .replace(/>>/g, '>>>')
        .replace(/let (\w+) = ([^;]*);/g, 'const $1 = ($2) >>> 0;')
        .replace(/return ([^;]*);/g, 'return ($1) >>> 0;')
        .replace(/select\(/g, 'pick(');
    const helpers = new Function('pick', `${source}\nreturn { umulhi, imulhi };`)(
        (/** @type {number} */ no, /** @type {number} */ yes, /** @type {boolean} */ when)=>
            (when ? yes : no));
    const samples = [0, 1, 2, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0x80000001, 0xffffffff,
        0x12345678, 0xdeadbeef, 0xcafef00d, 3000000000, 65537];
    for (const a of samples)
    {
        for (const b of samples)
        {
            const unsigned = Number((BigInt(a) * BigInt(b)) >> 32n);
            assert.equal(helpers.umulhi(a, b), unsigned, `umulhi(${a}, ${b})`);
            const product = BigInt(a | 0) * BigInt(b | 0);
            const signed = Number(BigInt.asUintN(32, product >> 32n));
            assert.equal(helpers.imulhi(a, b), signed, `imulhi(${a | 0}, ${b | 0})`);
        }
    }
});

test('udiv writes the quotient and the remainder, all ones for a zero divisor', ()=>{
    const byZero = 'r3.xyzw == vec4<u32>(0u)';
    assert.equal(emitted([udiv(r(0), r(1), r(2), r(3))]), [
        `let held0 = select((r2.xyzw % r3.xyzw), vec4<u32>(0xffffffffu), ${byZero});`,
        `r0 = select((r2.xyzw / r3.xyzw), vec4<u32>(0xffffffffu), ${byZero});`,
        'r1 = held0;',
    ].join('\n'));
});

// --- flow control ---

test('if, else and endif test the first component of the condition', ()=>{
    const branches = [ifNz(r(0, 'y')), mov(r(1), lu(1)), elseBranch(), mov(r(1), lu(2)), endif()];
    assert.equal(emitted(branches),
        'if (r0.yyyy.x != 0u) {\nr1 = vec4<u32>(1u);\n} else {\nr1 = vec4<u32>(2u);\n}');
    assert.equal(emitted([ifZ(r(0, 'x')), endif()]), 'if (r0.xxxx.x == 0u) {\n}');
});

test('a loop breaks on a condition, and the nesting is indented', ()=>{
    const translated = translate([loop(), breakcNz(r(0, 'x')), iadd(r(0), r(0), lu(1)),
        endloop()]);
    assert.deepEqual(translated.body.slice(0, 4), [
        '    loop {',
        '        if (r0.xxxx.x != 0u) { break; }',
        `        r0 = ${U}((${I}(r0.xyzw) + ${I}(vec4<u32>(1u))));`,
        '    }',
    ]);
});

test('discard is a pixel shader instruction and is refused elsewhere', ()=>{
    assert.equal(emitted([discardNz(r(0, 'x'))]), 'if (r0.xxxx.x != 0u) { discard; }');
    const vertex = translate([discardNz(r(0, 'x'))], { kind: SHADER_KIND.VERTEX });
    assert.deepEqual(vertex.unsupported, ['discard outside a pixel shader']);
});

test('a conditional return is a return inside an if', ()=>{
    assert.equal(emitted([retcNz(r(0, 'x'))]), 'if (r0.xxxx.x != 0u) {\nRET\n}');
});

test('a switch gathers the cases that share a body, and has a default whatever happens', ()=>{
    assert.equal(emitted([
        switchOn(r(0, 'x')),
        caseOf(0), caseOf(1), mov(r(1), lu(1)), breakOut(),
        caseOf(0xffffffff), mov(r(1), lu(2)), breakOut(),
        defaultCase(), mov(r(1), lu(3)), breakOut(),
        endswitch(),
    ]), [
        'switch (r0.xxxx.x) {',
        'case 0u, 1u: {', 'r1 = vec4<u32>(1u);', 'break;', '}',
        'case 4294967295u: {', 'r1 = vec4<u32>(2u);', 'break;', '}',
        'default: {', 'r1 = vec4<u32>(3u);', 'break;', '}',
        '}',
    ].join('\n'));
    assert.equal(emitted([
        switchOn(r(0, 'y')), caseOf(3), defaultCase(), mov(r(1), lu(1)), breakOut(),
        caseOf(4), endswitch(),
    ]), [
        'switch (r0.yyyy.x) {',
        'case 3u, default: {', 'r1 = vec4<u32>(1u);', 'break;', '}',
        'case 4u: {', '}',
        '}',
    ].join('\n'), 'a trailing case with nothing to do, and a default among the selectors');
    assert.equal(emitted([switchOn(r(0, 'x')), caseOf(2), breakOut(), endswitch()]),
        'switch (r0.xxxx.x) {\ncase 2u: {\nbreak;\n}\ndefault: {}\n}',
        'WGSL wants a default and Shader Model 4 does not');
});

test('a subroutine is written where it is called, on the caller\'s registers', ()=>{
    // The translator appends the program's last ret, which ends label 0 here.
    assert.equal(emitted([call(0), mov(r(2), r(1)), ret(), label(0), mov(r(1), lu(7))]),
        'r1 = vec4<u32>(7u);\nr2 = r1.xyzw;');
    assert.equal(emitted([callcNz(r(0, 'z'), 0), ret(), label(0), mov(r(1), lu(7))]),
        'if (r0.zzzz.x != 0u) {\nr1 = vec4<u32>(7u);\n}');
    const nested = translate([call(0), ret(), label(0), call(1), ret(), label(1),
        mov(r(3), lu(1))]);
    assert.equal(bodyOf(nested), 'r3 = vec4<u32>(1u);', 'a call from a subroutine');
    assert.deepEqual(nested.unsupported, []);
});

test('a subroutine that returns early runs once through a loop and breaks out of it', ()=>{
    assert.equal(emitted([call(0), ret(), label(0), retcNz(r(0, 'x')), mov(r(1), lu(5))]), [
        'var returned0 = false;',
        'loop {',
        'if (r0.xxxx.x != 0u) {', 'returned0 = true;', 'break;', '}',
        'r1 = vec4<u32>(5u);',
        'break;',
        '}',
    ].join('\n'));
    // A return from inside the subroutine's own loop leaves that loop, and
    // the flag takes it out of the one around the subroutine.
    assert.equal(emitted([call(0), ret(), label(0), loop(), retcNz(r(0, 'x')), endloop(),
        mov(r(1), lu(5))]), [
        'var returned0 = false;',
        'loop {',
        'loop {',
        'if (r0.xxxx.x != 0u) {', 'returned0 = true;', 'break;', '}',
        '}',
        'if (returned0) { break; }',
        'r1 = vec4<u32>(5u);',
        'break;',
        '}',
    ].join('\n'));
});

test('a call that recurs, or names no label, is refused', ()=>{
    assert.deepEqual(translate([call(0), ret(), label(0), call(0)]).unsupported,
        ['a recursive call']);
    assert.deepEqual(translate([call(4)]).unsupported,
        ['a call to l4, which the program does not have']);
});

// --- constant buffers and indexable temps ---

test('a constant buffer is indexed directly or by a register', ()=>{
    assert.equal(emitted([mov(r(0), cb(1, 7))]), 'r0 = cb1[7u].xyzw;');
    assert.equal(emitted([mov(r(0), indexedBy(cb(0, 2), r(1, 'x')))]),
        'r0 = cb0[(2u + r1.xxxx.x)].xyzw;');
    assert.equal(emitted([mov(r(0), indexedBy(cb(0, 0), r(1, 'w')))]),
        'r0 = cb0[r1.wwww.w].xyzw;');
});

test('the declarations become bindings in the stage group', ()=>{
    const translated = translate([mov(o(0), cb(2, 0))], {
        declarations: [
            dclConstantBuffer(2, 4),
            dclResource(1, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT),
            dclSampler(3, SAMPLER_MODE.COMPARISON),
            dclIndexableTemp(0, 6),
        ],
    });
    assert.deepEqual(translated.constantBuffers, [{ slot: 2, size: 4 }]);
    assert.deepEqual(translated.textures, [{
        slot: 1, dimension: RESOURCE_DIMENSION.TEXTURE2D, returnType: RETURN_TYPE.FLOAT,
        comparison: false,
    }]);
    assert.deepEqual(translated.samplers, [{ slot: 3, comparison: true }]);
    assert.deepEqual(translated.indexableTemps, [{ index: 0, size: 6 }]);
    assert.equal(translated.temps, 4);

    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const linked = linkProgram(vs, translated);
    assert.deepEqual(linked.groups[1], [
        { binding: BINDING.CONSTANT_BUFFER + 2, visibility: STAGE.FRAGMENT,
            buffer: { type: 'uniform', minBindingSize: 64 } },
        { binding: BINDING.TEXTURE + 1, visibility: STAGE.FRAGMENT,
            texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: BINDING.SAMPLER + 3, visibility: STAGE.FRAGMENT,
            sampler: { type: 'comparison' } },
    ]);
    assert.match(linked.fragment,
        /@group\(1\) @binding\(2\) var<uniform> cb2: array<vec4<u32>, 4>;/);
    assert.match(linked.fragment, /@group\(1\) @binding\(17\) var t1: texture_2d<f32>;/);
    assert.match(linked.fragment, /@group\(1\) @binding\(147\) var s3: sampler_comparison;/);
    assert.match(linked.fragment, /var x0: array<vec4<u32>, 6>;/);
    assert.match(linked.fragment, /var r3: vec4<u32>;/);
});

test('a pixel shader as fxc writes it, SV_TARGET with no system value, draws to target 0', ()=>{
    // `float4 color; float4 main() : SV_TARGET { return color; }`, compiled by fxc: its output
    // signature names SV_TARGET and leaves the system value field at zero.
    const words = [0x43425844, 0x80f1c810, 0xdacbbc8b, 0xe07b133e, 0x3059cbfa, 0x00000001,
        0x000000b8, 0x00000003, 0x0000002c, 0x0000003c, 0x00000070, 0x4e475349, 0x00000008,
        0x00000000, 0x00000008, 0x4e47534f, 0x0000002c, 0x00000001, 0x00000008, 0x00000020,
        0x00000000, 0x00000000, 0x00000003, 0x00000000, 0x0000000f, 0x545f5653, 0x45475241,
        0xabab0054, 0x52444853, 0x00000040, 0x00000040, 0x00000010, 0x04000059, 0x00208e46,
        0x00000000, 0x00000001, 0x03000065, 0x001020f2, 0x00000000, 0x06000036, 0x001020f2,
        0x00000000, 0x00208e46, 0x00000000, 0x00000000, 0x0100003e];
    const bytes = new Uint8Array(words.length * 4);
    words.forEach((word, i)=>new DataView(bytes.buffer).setUint32(i * 4, word, true));
    const container = /** @type {any} */ (parseDxbc(bytes));
    assert.equal(container.outputs[0].systemValue, SYSTEM_VALUE.UNDEFINED);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const linked = linkProgram(vs, translateShader(container));
    assert.deepEqual(linked.unsupported, []);
    assert.deepEqual(linked.targets, [0]);
    assert.match(linked.fragment, /@location\(0\) target0: vec4<f32>,/);
});

test('an immediate constant buffer becomes a module constant', ()=>{
    const translated = translate([mov(o(0), lu(0))], {
        declarations: [immediateConstantBuffer([[1, 2, 3, 4]])],
    });
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    assert.match(linkProgram(vs, translated).fragment,
        /const icb = array<vec4<u32>, 1>\(vec4<u32>\(1u, 2u, 3u, 4u\)\);/);
});

// --- textures ---

const TEXTURE = [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT), dclSampler(0)];

test('a value held for a partial store does not take a texture\'s name', ()=>{
    // A `let t0` would hide texture t0 from the second sample.
    const body = bodyOf(translate([sample(r(0, 'xy'), v(0), t(0), s(0)),
        sample(r(1), v(0), t(0), s(0))], { declarations: TEXTURE }));
    assert.match(body, /^let held0 = /);
    assert.doesNotMatch(body, /let t\d/);
});

test('sample reads a float texture through its sampler and applies the swizzle', ()=>{
    const translated = translate([sample(r(0), v(0, 'xy'), t(0, 'wzyx'), s(0))],
        { declarations: TEXTURE });
    assert.equal(bodyOf(translated),
        `r0 = ${U}((textureSample(t0, s0, ${F}(v0.xyyy).xy)).wzyx);`);
});

test('sample_l names the level and works in any stage; sample does not', ()=>{
    const pixel = translate([sampleL(r(0), v(0, 'xy'), t(0), s(0), l(2))],
        { declarations: TEXTURE });
    assert.equal(bodyOf(pixel),
        `r0 = ${U}((textureSampleLevel(t0, s0, ${F}(v0.xyyy).xy, `
        + `${F}(vec4<u32>(1073741824u)).x)).xyzw);`);
    const vertex = translate([sample(r(0), v(0, 'xy'), t(0), s(0))],
        { declarations: TEXTURE, kind: SHADER_KIND.VERTEX });
    assert.deepEqual(vertex.unsupported, ['sample outside a pixel shader']);
});

test('a compare sample marks its texture as depth and splats the one float', ()=>{
    const translated = translate([sampleCLz(r(0), v(0, 'xy'), t(0), s(0), v(0, 'z'))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT),
            dclSampler(0, SAMPLER_MODE.COMPARISON)],
    });
    assert.equal(translated.textures[0].comparison, true);
    assert.equal(bodyOf(translated),
        `r0 = ${U}((vec4<f32>(textureSampleCompareLevel(t0, s0, ${F}(v0.xyyy).xy, `
        + `${F}(v0.zzzz).x))).xyzw);`);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const linked = linkProgram(vs, translated);
    assert.match(linked.fragment, /var t0: texture_depth_2d;/);
    assert.deepEqual(linked.groups[1][0].texture, { sampleType: 'depth', viewDimension: '2d' });
});

test('a float texture bound to a depth buffer is declared as depth and read as (d, 0, 0, 1)',
    ()=>{
        // A shadow map read as R32_FLOAT, a depth read back as R24_UNORM_X8:
        // a float binding does not take a depth texture, and the read was
        // of an empty one. Direct3D answers a one-channel view as (r, 0, 0, 1).
        const options = { depth: [0] };
        const sampled = translate([sample(r(0), v(0, 'xy'), t(0), s(0))],
            { declarations: TEXTURE, options });
        assert.equal(sampled.textures[0].depth, true);
        assert.equal(bodyOf(sampled), `r0 = ${U}((vec4<f32>(textureSample(t0, s0, `
            + `${F}(v0.xyyy).xy), 0.0, 0.0, 1.0)).xyzw);`);
        const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
        const linked = linkProgram(vs, sampled);
        assert.match(linked.fragment, /var t0: texture_depth_2d;/);
        assert.deepEqual(linked.groups[1][0].texture, { sampleType: 'depth', viewDimension: '2d' });
        const level = translate([sampleL(r(0), v(0, 'xy'), t(0), s(0), l(2))],
            { declarations: TEXTURE, options });
        assert.match(bodyOf(level), /textureSampleLevel\(t0, s0, .*, i32\(round\(/,
            'a depth texture\'s level is a whole number');
        const loaded = translate([ld(r(0), r(1), t(0))], { declarations: TEXTURE, options });
        assert.match(bodyOf(loaded), /vec4<f32>\(textureLoad\(t0, .*\), 0\.0, 0\.0, 1\.0\)/);
        const plain = translate([sample(r(0), v(0, 'xy'), t(0), s(0))], { declarations: TEXTURE });
        assert.equal(plain.textures[0].depth, undefined, 'only where a depth buffer is bound');
    });

test('a plain sampler that reads a depth texture is declared non-filtering, and a stencil view'
    + ' is read in green (test_depth_stencil_sampling, d3d11.c:10676)', ()=>{
    const sampled = translate([sample(r(0), v(0, 'xy'), t(0), s(0))],
        { declarations: TEXTURE, options: { depth: [0] } });
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const linked = linkProgram(vs, sampled);
    assert.deepEqual(linked.groups[1].find(entry=>entry.sampler)?.sampler,
        { type: 'non-filtering' });
    const plain = linkProgram(vs, translate([sample(r(0), v(0, 'xy'), t(0), s(0))],
        { declarations: TEXTURE }));
    assert.deepEqual(plain.groups[1].find(entry=>entry.sampler)?.sampler, { type: 'filtering' });
    const stencil = translate([ld(r(0), r(1), t(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.UINT)],
        options: { stencil: [0] } });
    assert.match(bodyOf(stencil), /\(vec4<u32>\(0u, \(textureLoad\(t0, held0, held1\)\)\.x, 0u, 1u\)\)/);
});

test('ld fetches a texel by integer address with the level in w', ()=>{
    const translated = translate([ld(r(0), r(1), t(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.UINT)],
    });
    assert.equal(bodyOf(translated), [`let held0 = ${I}(r1.xyzw).xy;`,
        `let held1 = ${I}(r1.xyzw).w;`,
        'r0 = select(vec4<u32>(0u), (textureLoad(t0, held0, held1)).xyzw, u32(held1)'
            + ' < textureNumLevels(t0) && all(vec2<u32>(held0) < textureDimensions(t0,'
            + ' u32(held1))));'].join('\n'),
    'an address past the level or the levels reads zero (test_texture, d3d11.c:9385)');
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    assert.match(linkProgram(vs, translated).fragment, /var t0: texture_2d<u32>;/);
    const array = translate([ld(r(0), r(1), t(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2DARRAY, RETURN_TYPE.UINT)],
    });
    assert.match(bodyOf(array), / && u32\(held2\) < textureNumLayers\(t0\)\);$/,
        'and a layer past the last');
});

test('a 3D texture samples with three coordinates and an array with a layer', ()=>{
    const volume = translate([sample(r(0), v(0), t(0), s(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE3D, RETURN_TYPE.FLOAT),
            dclSampler(0)],
    });
    assert.match(bodyOf(volume), /textureSample\(t0, s0, bitcast<vec4<f32>>\(v0.xyzw\).xyz\)/);
    const array = translate([sample(r(0), v(0), t(0), s(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2DARRAY, RETURN_TYPE.FLOAT),
            dclSampler(0)],
    });
    assert.match(bodyOf(array),
        /textureSample\(t0, s0, bitcast<vec4<f32>>\(v0.xyzw\).xy, i32\(bitcast<vec4<f32>>\(v0.xyzw\).z\)\)/);
});

test('resinfo answers the size and level count, as floats or as integers', ()=>{
    const level = 'vec4<u32>(1u).x';
    const inRange = `${level} < textureNumLevels(t0)`;
    const floats = translate([resinfo(r(0), lu(1), t(0))], { declarations: TEXTURE });
    assert.equal(bodyOf(floats), [
        `let held0 = textureDimensions(t0, min(${level}, textureNumLevels(t0) - 1u));`,
        `r0 = (${U}(vec4<f32>(f32(select(0u, held0.x, ${inRange})), `
            + `f32(select(0u, held0.y, ${inRange})), f32(0u), f32(textureNumLevels(t0))))).xyzw;`,
    ].join('\n'), 'a level past the last has no size');
    const integers = translate([resinfo(r(0), lu(1), t(0, 'wzyx'), true)],
        { declarations: TEXTURE });
    assert.equal(bodyOf(integers).split('\n')[1],
        `r0 = (vec4<u32>(select(0u, held0.x, ${inRange}), select(0u, held0.y, ${inRange}), 0u, `
        + 'textureNumLevels(t0))).wzyx;', 'and the resource\'s swizzle picks among them');
});

test('resinfo answers every shape: depth, array size, and reciprocals when asked', ()=>{
    /**
     * @param {number} dimension
     * @param {import('./shader-fixtures.js').AsmInstruction} instruction
     */
    const resinfoOf = (dimension, instruction)=>bodyOf(translate([instruction], {
        declarations: [dclResource(0, dimension, RETURN_TYPE.FLOAT)],
    })).split('\n')[1];
    const inRange = 'vec4<u32>(0u).x < textureNumLevels(t0)';
    assert.equal(resinfoOf(RESOURCE_DIMENSION.TEXTURE3D, resinfo(r(0), lu(0), t(0), true)),
        `r0 = (vec4<u32>(select(0u, held0.x, ${inRange}), select(0u, held0.y, ${inRange}), `
        + `select(0u, held0.z, ${inRange}), textureNumLevels(t0))).xyzw;`);
    assert.equal(resinfoOf(RESOURCE_DIMENSION.TEXTURE2DARRAY, resinfo(r(0), lu(0), t(0), true)),
        `r0 = (vec4<u32>(select(0u, held0.x, ${inRange}), select(0u, held0.y, ${inRange}), `
        + 'textureNumLayers(t0), textureNumLevels(t0))).xyzw;');
    assert.equal(resinfoOf(RESOURCE_DIMENSION.TEXTURE1DARRAY, resinfo(r(0), lu(0), t(0), true)),
        `r0 = (vec4<u32>(select(0u, held0.x, ${inRange}), textureNumLayers(t0), 0u, `
        + 'textureNumLevels(t0))).xyzw;');
    const width = `select(0u, held0.x, ${inRange})`;
    assert.equal(resinfoOf(RESOURCE_DIMENSION.TEXTURE1D, resinfoRcp(r(0), lu(0), t(0))),
        `r0 = (${U}(vec4<f32>(select(0.0, 1.0 / f32(${width}), ${width} != 0u), f32(0u), `
        + 'f32(0u), f32(textureNumLevels(t0))))).xyzw;');
});

test('a one-dimensional texture is read as a row of a two-dimensional one', ()=>{
    const ONE_D = [dclResource(0, RESOURCE_DIMENSION.TEXTURE1D, RETURN_TYPE.FLOAT),
        dclSampler(0)];
    const sampled = translate([sample(r(0), v(0), t(0), s(0))], { declarations: ONE_D });
    assert.equal(bodyOf(sampled),
        `r0 = ${U}((textureSample(t0, s0, vec2<f32>(${F}(v0.xyzw).x, 0.5))).xyzw);`);
    const graded = translate([sampleD(r(0), v(0), t(0), s(0), r(1), r(2))],
        { declarations: ONE_D });
    assert.match(bodyOf(graded), new RegExp(
        `, vec2<f32>\\(bitcast<vec4<f32>>\\(r1\\.xyzw\\)\\.x, 0\\.0\\), `
        + 'vec2<f32>\\(bitcast<vec4<f32>>\\(r2\\.xyzw\\)\\.x, 0\\.0\\)\\)'));
    const loaded = translate([ld(r(0), r(1), t(0))], { declarations: ONE_D });
    assert.match(bodyOf(loaded), new RegExp('^let held0 = vec2<i32>\\(bitcast<vec4<i32>>'
        + '\\(r1\\.xyzw\\)\\.x, 0\\);'));
    const array = translate([sample(r(0), v(0), t(0), s(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE1DARRAY, RETURN_TYPE.FLOAT),
            dclSampler(0)],
    });
    assert.match(bodyOf(array), /vec2<f32>\(bitcast<vec4<f32>>\(v0.xyzw\).x, 0.5\), i32\(/);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    assert.match(linkProgram(vs, sampled).fragment, /var t0: texture_2d<f32>;/);
    assert.deepEqual(linkProgram(vs, array).groups[1][0].texture,
        { sampleType: 'float', viewDimension: '2d-array' });
});

test('ld_ms reads the one sample every texture here has, and zero for any other', ()=>{
    const translated = translate([ldMs(r(0), r(1), t(0), r(2, 'x'))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2DMS, RETURN_TYPE.FLOAT)],
    });
    assert.match(bodyOf(translated), /\nlet held1 = 0;\nr0 = select\(select\(vec4<u32>\(0u\),/);
    assert.match(bodyOf(translated), /, vec4<u32>\(0u\), r2\.xxxx\.x != 0u\);$/);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    assert.match(linkProgram(vs, translated).fragment, /var t0: texture_2d<f32>;/);
    const plain = translate([ld(r(0), r(1), t(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2DMSARRAY, RETURN_TYPE.FLOAT)],
    });
    assert.match(bodyOf(plain), /textureLoad\(t0, held0, held2, held1\)/);
    assert.match(bodyOf(plain), /^let held0 = bitcast<vec4<i32>>\(r1\.xyzw\)\.xy;\nlet held1 = 0;/);
});

test('ld from a buffer view reads storage, checked against the view and decoded by it', ()=>{
    const translated = translate([ld(r(0), r(1, 'x'), t(2, 'zyxw'))], {
        declarations: [dclResource(2, RESOURCE_DIMENSION.BUFFER, RETURN_TYPE.FLOAT)],
    });
    assert.equal(bodyOf(translated), 'r0 = (loadt2(r1.xxxx.x)).zyxw;');
    assert.deepEqual(translated.unsupported, []);
    assert.deepEqual(translated.helpers, ['bufferElement']);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const linked = linkProgram(vs, translated);
    assert.match(linked.fragment, /@binding\(18\) var<storage, read> t2: array<u32>;/);
    assert.match(linked.fragment, /@binding\(162\) var<uniform> t2view: vec4<u32>;/);
    assert.match(linked.fragment, /if \(index >= t2view\.z\) \{ return vec4<u32>\(0u\); \}/,
        'an element past the view reads zero');
    assert.match(linked.fragment, /return bufferElement\(t2view\.x, words, \(byte % 4u\) \* 8u\);/);
    assert.deepEqual(linked.groups[1], [
        { binding: BINDING.TEXTURE + 2, visibility: STAGE.FRAGMENT,
            buffer: { type: 'read-only-storage' } },
        { binding: BINDING.BUFFER_VIEW + 2, visibility: STAGE.FRAGMENT,
            buffer: { type: 'uniform' } },
    ]);
});

test('a buffer element is decoded by the view\'s format', ()=>{
    const text = HELPERS.bufferElement.text.join('\n');
    const FORMAT = DXGI_FORMAT;
    /** @param {number} format */
    const clauseOf = format=>text.split('\n').find(line=>line.includes(` ${format}u:`)
        || line.includes(` ${format}u,`)) ?? '';
    assert.match(clauseOf(FORMAT.R32G32B32A32_FLOAT), /return w;/, 'four dwords as they are');
    assert.match(clauseOf(FORMAT.R32_FLOAT), /vec4<u32>\(w\.x, 0u, 0u, 0x3f800000u\)/,
        'a missing component is zero and a missing alpha one');
    assert.match(clauseOf(FORMAT.R32_UINT), /vec4<u32>\(w\.x, 0u, 0u, 1u\)/);
    assert.match(clauseOf(FORMAT.R8G8B8A8_UNORM), /unpack4x8unorm\(w\.x\)/);
    assert.match(clauseOf(FORMAT.B8G8R8A8_UNORM), /unpack4x8unorm\(w\.x\)\.zyxw/);
    assert.match(clauseOf(FORMAT.R16_UINT), /\(\(w\.x >> s\) & 0xffffu\)/,
        'a narrow element from the bit it starts at');
    for (const format of [FORMAT.R32G32B32A32_FLOAT, FORMAT.R32G32B32_UINT,
        FORMAT.R16G16B16A16_FLOAT, FORMAT.R16G16_SNORM, FORMAT.R16_FLOAT, FORMAT.R8G8B8A8_SINT,
        FORMAT.R8G8_UINT, FORMAT.R8_UNORM, FORMAT.R10G10B10A2_UNORM])
    {
        assert.ok(BUFFER_VIEW_FORMATS.has(format), `format ${format}`);
    }
    assert.ok(!BUFFER_VIEW_FORMATS.has(FORMAT.R11G11B10_FLOAT), 'one it does not decode');
    assert.match(text, /default: \{ return vec4<u32>\(0u\); \}/);
});

test('gather4 gathers the first component of four texels', ()=>{
    const translated = translate([gather4(r(0), v(0), t(0, 'yxzw'), s(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT),
            dclSampler(0)],
    });
    assert.equal(bodyOf(translated),
        `r0 = ${U}((textureGather(0, t0, s0, ${F}(v0.xyzw).xy)).yxzw);`);
    const integer = translate([gather4(r(0), v(0), t(0), s(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.UINT),
            dclSampler(0)],
    });
    assert.deepEqual(integer.unsupported,
        ['gather4 on an integer, one- or three-dimensional texture']);
});

test('a gather takes the channel its sampler selects, an immediate offset as WGSL\'s, a'
    + ' register\'s by moving the address, and a reference as a compare (test_gather,'
    + ' test_gather_c, d3d11.c:28200)', ()=>{
    const declarations = [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT),
        dclSampler(0)];
    const green = translate([{ ...gather4(r(0), v(0), t(0), { ...s(0), swizzle: 'yyyy' }),
        offset: [1, -1, 0] }], { declarations });
    assert.equal(bodyOf(green), `r0 = ${U}((textureGather(1, t0, s0, ${F}(v0.xyzw).xy`
        + ', vec2<i32>(1, -1))).xyzw);');
    const programmed = bodyOf(translate([gather4Po(r(0), v(0), r(1), t(0), s(0))],
        { declarations }));
    assert.match(programmed, /vec2<f32>\(bitcast<vec4<i32>>\(r1\.xyzw\)\.xy\) \/ vec2<f32>\(textureDimensions\(t0, 0\)\.xy\)/);
    const compared = translate([gather4C(r(0), v(0), t(0), s(0), r(2, 'x'))],
        { declarations });
    assert.match(bodyOf(compared), /textureGatherCompare\(t0, s0, [^;]*, bitcast<vec4<f32>>\(r2\.xxxx\)\.x\)/);
    assert.equal(compared.textures[0].comparison, true);
});

test('a sample and a load move by their immediate offset (test_texture, d3d11.c)', ()=>{
    const declarations = [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT),
        dclSampler(0)];
    assert.match(bodyOf(translate([{ ...sample(r(0), v(0), t(0), s(0)), offset: [-2, 3, 0] }],
        { declarations })), /textureSample\(t0, s0, [^;]*\.xy, vec2<i32>\(-2, 3\)\)/);
    assert.match(bodyOf(translate([{ ...ld(r(0), v(0), t(0)), offset: [1, 0, 0] }],
        { declarations })), /\.xy \+ vec2<i32>\(1, 0\);/);
});

test('an instruction with no translation is named, and nothing plausible is emitted', ()=>{
    const translated = translate([{ opcode: 213, operands: [r(0), r(1), r(2), r(3)] }],
        { declarations: TEXTURE });
    assert.deepEqual(translated.unsupported, ['msad']);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    assert.ok(linkProgram(vs, translated).unsupported.includes('msad'),
        'and the pair carries the refusal');
});

// --- linking ---

test('the fragment stage lets a derivative be taken in divergent flow, as Direct3D does', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const ps = translateShader(/** @type {any} */ (parseDxbc(solidPixelShader([0, 0, 1, 1]))));
    const linked = linkProgram(vs, ps);
    assert.ok(linked.fragment.startsWith('diagnostic(off, derivative_uniformity);\n'),
        'a directive, before any declaration');
    assert.ok(!linked.vertex.includes('diagnostic'));
});

test('an output with no target bound is left out, and with none left nothing is returned', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const ps = translateShader(/** @type {any} */ (parseDxbc(solidPixelShader([0, 0, 1, 1]))));
    const kept = linkProgram(vs, ps, { targets: [0, 3] });
    assert.match(kept.fragment, /@location\(0\) target0/);
    const none = linkProgram(vs, ps, { targets: [] });
    assert.deepEqual(none.targets, [0], 'what the shader writes is still reported');
    assert.doesNotMatch(none.fragment, /FragmentOut/);
    assert.match(none.fragment, /@fragment fn fragmentMain\(\) \{/);
    assert.match(none.fragment, /\n {4}return;\n\}$/);
});

test('a pass-through vertex shader and a solid pixel shader link into two entry points', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const ps = translateShader(/** @type {any} */ (parseDxbc(solidPixelShader([0, 0, 1, 1]))));
    const linked = linkProgram(vs, ps);
    assert.deepEqual(linked.unsupported, []);
    assert.equal(linked.vertex, [
        'struct VertexIn {',
        '    @location(0) v0: vec4<f32>,',
        '};',
        'struct VertexOut {',
        '    @builtin(position) position: vec4<f32>,',
        '};',
        '@vertex fn vertexMain(in: VertexIn) -> VertexOut {',
        '    var v0: vec4<u32> = vec4<u32>(0u);',
        '    v0 = bitcast<vec4<u32>>(in.v0);',
        '    var o0: vec4<u32>;',
        '    o0 = v0.xyzw;',
        '    return VertexOut(bitcast<vec4<f32>>(o0));',
        '}',
    ].join('\n'));
    assert.equal(linked.fragment, [
        'diagnostic(off, derivative_uniformity);',
        'struct FragmentOut {',
        '    @location(0) target0: vec4<f32>,',
        '};',
        '@fragment fn fragmentMain() -> FragmentOut {',
        '    var o0: vec4<u32>;',
        '    o0 = vec4<u32>(0u, 0u, 1065353216u, 1065353216u);',
        '    return FragmentOut(bitcast<vec4<f32>>(o0));',
        '}',
    ].join('\n'));
    assert.deepEqual(linked.attributes,
        [{ location: 0, semantic: 'POSITION', index: 0, componentType: COMPONENT_TYPE.FLOAT }]);
    assert.deepEqual(linked.targets, [0]);
    assert.deepEqual(linked.groups, [[], []]);
});

test('a pixel shader\'s coverage is the fragment\'s sample mask, read and written'
    + ' (test_sample_mask)', ()=>{
    const ps = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 },
            { name: 'SV_Coverage', register: 0xffffffff, mask: 0x1 }],
        instructions: [dclOutput(o(0)), mov(o(0), l(1, 1, 1, 1)),
            iadd(oMask(), vCoverage('xxxx'), lu(5)), ret()],
    }))));
    assert.deepEqual(ps.unsupported, []);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const linked = linkProgram(vs, ps);
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.fragment, /@builtin\(sample_mask\) mask: u32,/);
    assert.match(linked.fragment, /@builtin\(sample_mask\) coverage: u32,/);
    assert.match(linked.fragment, /let vCoverage = in\.coverage;/);
    assert.match(linked.fragment, /var oMask: u32 = 0xffffffffu;/);
    assert.match(linked.fragment, /oMask = \(.*vec4<u32>\(vCoverage\).*\)\.x;/);
    assert.match(linked.fragment, /return FragmentOut\(.*, oMask\);/);
    assert.doesNotMatch(linked.fragment, /@location\(4294967295\)/);
});

test('a varying is passed by register, as the hardware does, whatever the names say there'
    + ' (test_shader_stage_input_output_matching)', ()=>{
    const COLOURS = [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
        { name: 'COLOR', index: 0, register: 1 }, { name: 'COLOR', index: 1, register: 2 }];
    const vs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.VERTEX, outputs: COLOURS,
        instructions: [dclOutputSiv(o(0), SYSTEM_VALUE.POSITION), dclOutput(o(1)),
            dclOutput(o(2)), mov(o(0), l(0, 0, 0, 1)), mov(o(1), l(1, 0, 0, 1)),
            mov(o(2), l(0, 1, 0, 1)), ret()],
    }))));
    // The pixel shader names its registers the other way round.
    const ps = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [COLOURS[0], { name: 'COLOR', index: 1, register: 1 },
            { name: 'COLOR', index: 0, register: 2 }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [dclInputPs(v(1)), dclInputPs(v(2)), dclOutput(o(0)), mov(o(0), v(2)),
            ret()],
    }))));
    const linked = linkProgram(vs, ps);
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.vertex, /@location\(0\) o1: vec4<f32>,\s+@location\(1\) o2/);
    assert.match(linked.fragment, /@location\(0\) v1: vec4<f32>,\s+@location\(1\) v2/);
});

test('a pixel input at a register the vertex shader did not write is looked for by name', ()=>{
    // The vertex shader writes COLOR in o1; a pixel shader that reads it in v3
    // finds it, at the location the vertex output was given.
    const vs = translateShader(/** @type {any} */ (parseDxbc(colouredVertexShader())));
    const ps = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [{ name: 'COLOR', register: 3 }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [dclInputPs(v(3)), dclOutput(o(0)), mov(o(0), v(3)), ret()],
    }))));
    const linked = linkProgram(vs, ps);
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.vertex, /@location\(0\) o1: vec4<f32>,/);
    assert.match(linked.fragment, /@location\(0\) v3: vec4<f32>,/);
    assert.match(linked.fragment, /v3 = bitcast<vec4<u32>>\(in.v3\);/);
});

test('a pixel input the vertex shader never writes is reported', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const ps = translateShader(/** @type {any} */ (parseDxbc(colouredPixelShader())));
    assert.deepEqual(linkProgram(vs, ps).unsupported,
        ['pixel input COLOR0 has no vertex output']);
    // One the pixel shader declares and never reads needs none
    // (test_input_assembler, d3d11.c:19498).
    const unread = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [{ name: 'COLOR', register: 0, readWriteMask: 0 }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [dclOutput(o(0)), mov(o(0), l(1, 1, 1, 1)), ret()],
    }))));
    assert.deepEqual(linkProgram(vs, unread).unsupported, []);
});

test('integer varyings are flat, and integer attributes keep their type', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'POSITION', register: 0 },
            { name: 'BLENDINDICES', register: 1, componentType: COMPONENT_TYPE.UINT }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'BLENDINDICES', register: 1, componentType: COMPONENT_TYPE.UINT }],
        instructions: [dclInput(v(0)), dclInput(v(1)), dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            dclOutput(o(1)), mov(o(0), v(0)), mov(o(1), v(1)), ret()],
    }))));
    const ps = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [{ name: 'BLENDINDICES', register: 0, componentType: COMPONENT_TYPE.UINT }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0,
            componentType: COMPONENT_TYPE.UINT }],
        instructions: [dclInputPs(v(0)), dclOutput(o(0)), mov(o(0), v(0)), ret()],
    }))));
    const linked = linkProgram(vs, ps);
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.vertex, /@location\(1\) v1: vec4<u32>,/);
    assert.match(linked.vertex, /v1 = in.v1;/);
    assert.match(linked.vertex, /@location\(0\) @interpolate\(flat\) o1: vec4<u32>,/);
    assert.match(linked.fragment, /@location\(0\) @interpolate\(flat\) v0: vec4<u32>,/);
    assert.match(linked.fragment, /@location\(0\) target0: vec4<u32>,/);
    assert.match(linked.fragment, /return FragmentOut\(o0\);/);
});

test('the system values a stage can read arrive as builtins', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'SV_VERTEXID', systemValue: SYSTEM_VALUE.VERTEX_ID, register: 0,
            componentType: COMPONENT_TYPE.UINT }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        instructions: [dclInputSiv(v(0), SYSTEM_VALUE.VERTEX_ID),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION), utof(o(0), v(0)), ret()],
    }))));
    const ps = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'SV_ISFRONTFACE', systemValue: SYSTEM_VALUE.IS_FRONT_FACE, register: 1,
                componentType: COMPONENT_TYPE.UINT }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 },
            { name: 'SV_DEPTH', systemValue: SYSTEM_VALUE.DEPTH, register: 0xffffffff }],
        instructions: [dclInputPsSiv(v(0), SYSTEM_VALUE.POSITION),
            dclInputPsSiv(v(1), SYSTEM_VALUE.IS_FRONT_FACE), dclOutput(o(0)), dclOutput(oDepth()),
            mov(o(0), v(0)), mov(oDepth(), v(1, 'x')), ret()],
    }))));
    const linked = linkProgram(vs, ps);
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.vertex, /@builtin\(vertex_index\) v0: u32,/);
    assert.match(linked.vertex, /v0.x = in.v0;/);
    assert.match(linked.fragment, /@builtin\(position\) v0: vec4<f32>,/);
    assert.match(linked.fragment, /@builtin\(front_facing\) v1: bool,/);
    assert.match(linked.fragment, /v1.x = select\(0u, 0xffffffffu, in.v1\);/);
    assert.match(linked.fragment, /@builtin\(frag_depth\) depth: f32,/);
    assert.match(linked.fragment, /oDepth = bitcast<f32>\(\(v1.xxxx\).x\);/);
    assert.match(linked.fragment, /return FragmentOut\(bitcast<vec4<f32>>\(o0\), oDepth\);/);
    assert.deepEqual(linked.attributes, [], 'a builtin is not a vertex attribute');
});

test('a depth written with a promise of its direction is the nearer of it and the rasterized'
    + ' depth (test_conservative_depth_output, d3d11.c:29380)', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    /** @param {string} name @param {number} systemValue @param {number} type */
    const promising = (name, systemValue, type)=>translateShader(/** @type {any} */ (parseDxbc(
        assemble({
            kind: SHADER_KIND.PIXEL,
            outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 },
                { name, systemValue, register: 0xffffffff }],
            instructions: [dclOutput(o(0)), mov(o(0), l(0, 1, 0, 1)),
                mov({ type, indices: [], mask: 1, swizzle: 'x' }, l(0.25)), ret()],
        }))));
    const greater = linkProgram(vs, promising('SV_DepthGreaterEqual',
        SYSTEM_VALUE.DEPTH_GREATER_EQUAL, 38));
    assert.deepEqual(greater.unsupported, []);
    assert.match(greater.fragment, /@builtin\(position\) depthPosition: vec4<f32>,/);
    assert.match(greater.fragment, /max\(oDepth, in\.depthPosition\.z\)\);/);
    // As a compiler writes the signature: by name alone, no system value.
    const less = linkProgram(vs, promising('SV_DepthLessEqual', 0, 39));
    assert.match(less.fragment, /min\(oDepth, in\.depthPosition\.z\)\);/);
    assert.doesNotMatch(less.fragment, /@location\(4294967295\)/);
});

test('clip distances clip on the device or by the fragment stage; a cull distance discards a'
    + ' primitive all of whose vertices are on its far side (test_combined_clip_and_cull_distances,'
    + ' d3d11.c:30460)', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'POSITION', register: 0 }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'SV_CLIPDISTANCE', systemValue: SYSTEM_VALUE.CLIP_DISTANCE, register: 1,
                mask: 0x7 },
            { name: 'SV_CULLDISTANCE', systemValue: SYSTEM_VALUE.CULL_DISTANCE, register: 2,
                mask: 0x1 }],
        instructions: [dclInput(v(0)), dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            dclOutputSiv(o(1, 'xyz'), SYSTEM_VALUE.CLIP_DISTANCE),
            dclOutputSiv(o(2, 'x'), SYSTEM_VALUE.CULL_DISTANCE),
            mov(o(0), v(0)), mov(o(1, 'xyz'), v(0, 'xyz')), mov(o(2, 'x'), v(0, 'x')), ret()],
    }))));
    const ps = translateShader(/** @type {any} */ (parseDxbc(solidPixelShader([0, 1, 0, 1]))));
    const device = linkProgram(vs, ps, { clipDistances: true });
    assert.deepEqual(device.unsupported, []);
    assert.match(device.vertex, /^enable clip_distances;/);
    assert.match(device.vertex, /@builtin\(clip_distances\) clipDistances: array<f32, 3>,/);
    assert.match(device.fragment, /if \(any\(in\.cullKept0 == vec4<f32>\(0\.0\)\)\) \{ discard; \}/);
    const fragmentCut = linkProgram(vs, ps);
    assert.doesNotMatch(fragmentCut.vertex, /clip_distances/);
    assert.match(fragmentCut.fragment, /if \(any\(in\.clipDistance0 < vec4<f32>\(0\.0\)\)\) \{ discard; \}/);
    assert.match(fragmentCut.vertex, /select\(0\.0, 1\.0, bitcast<f32>\(o2\.x\) >= 0\.0\)/);
});

test('a vertex shader that writes no position cannot be linked', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.VERTEX,
        outputs: [{ name: 'COLOR', register: 0 }],
        instructions: [dclOutput(o(0)), mov(o(0), lu(0)), ret()],
    }))));
    const ps = translateShader(/** @type {any} */ (parseDxbc(solidPixelShader([1, 1, 1, 1]))));
    assert.deepEqual(linkProgram(vs, ps).unsupported,
        ['a vertex shader that writes no SV_Position']);
});

test('a pixel output with no system value, COLOR1 of a backwards-compatible shader, writes the'
    + ' target its register names', ()=>{
    const ps = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        outputs: [{ name: 'COLOR', index: 1, systemValue: SYSTEM_VALUE.UNDEFINED, register: 1 }],
        instructions: [dclOutput(o(1)), mov(o(1), l(1, 0, 0, 1)), ret()],
    }))));
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const linked = linkProgram(vs, ps);
    assert.deepEqual(linked.unsupported ?? [], []);
    assert.match(linked.fragment, /@location\(1\) target1: vec4<f32>,/);
});

test('two semantics packed into one register pass as one varying, which the pixel stage reads'
    + ' whole', ()=>{
    const POSITION = { name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 };
    const vs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'POSITION', register: 0 }],
        outputs: [POSITION, { name: 'TEXCOORD', index: 0, register: 1, mask: 0x3 },
            { name: 'TEXCOORD', index: 1, register: 1, mask: 0xc }],
        instructions: [dclInput(v(0)), dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            dclOutput(o(1)), mov(o(0), v(0)), mov(o(1), v(0)), ret()],
    }))));
    const ps = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [POSITION, { name: 'TEXCOORD', index: 0, register: 1, mask: 0x3 },
            { name: 'TEXCOORD', index: 1, register: 1, mask: 0xc }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [dclInputPs(v(1)), dclOutput(o(0)), mov(o(0), v(1)), ret()],
    }))));
    const linked = linkProgram(vs, ps);
    assert.equal(linked.vertex.match(/@location\(0\) o1: vec4<f32>,/g)?.length, 1);
    assert.equal(linked.vertex.match(/@location\(1\)/g), null, 'no second varying');
    assert.equal(linked.fragment.match(/@location\(0\) v1: vec4<f32>,/g)?.length, 1);
});

test('a compute shader is a module of its own: its group\'s size, its thread ids, the views it'
    + ' writes as storage, shared memory, and an atomic made on what it is made on', ()=>{
    const cs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.COMPUTE,
        major: 5,
        instructions: [
            dclThreadGroup(8, 4, 1),
            dclUavRaw(0),
            dclUavStructured(1, 8),
            dclTgsmRaw(0, 64),
            dclTemps(2),
            ishl(r(0, 'x'), vThreadID('x'), lu(2)),
            storeRaw(u(0, 'x'), r(0, 'x'), vThreadID('x')),
            ldRaw(r(1, 'xy'), r(0, 'x'), u(0, 'xy')),
            storeStructured(u(1, 'xy'), vThreadID('x'), lu(0), r(1, 'xyxx')),
            storeRaw(g(0, 'x'), lu(0), vThreadIDInGroupFlattened('x')),
            sync(0x3),
            atomicIadd(u(0, 'x'), lu(0), lu(1)),
            immAtomicImax(r(1, 'x'), u(1, 'x'), vThreadID('xy'), lu(5)),
            ret(),
        ],
    }))));
    assert.deepEqual(cs.unsupported, []);
    assert.deepEqual(cs.threadGroup, [8, 4, 1]);
    assert.deepEqual(cs.uavs.map(uav=>[uav.slot, uav.structure, uav.stride, uav.atomic,
        uav.loaded]), [[0, 'raw', 0, true, true], [1, 'structured', 8, true, false]]);
    const linked = linkCompute(cs);
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.code, /@compute @workgroup_size\(8, 4, 1\)/);
    assert.match(linked.code, /var<storage, read_write> u0: array<atomic<u32>>;/);
    assert.match(linked.code, /var<workgroup> g0: array<u32, 16>;/);
    assert.match(linked.code, /fn u1_atomic_imax\(i: u32, value: u32, compare: u32\) -> u32/);
    assert.match(linked.code, /workgroupBarrier\(\);/);
    // Structure 1 of eight bytes, member at byte 0: dword (index * 8 + 0) / 4.
    assert.match(linked.code, /\* 8u \+ /);
    assert.deepEqual(linked.entries.map(entry=>[entry.binding, entry.visibility,
        entry.buffer?.type]), [
        [BINDING.UAV, STAGE.COMPUTE, 'storage'], [BINDING.UAV_VIEW, STAGE.COMPUTE, 'uniform'],
        [BINDING.UAV + 1, STAGE.COMPUTE, 'storage'],
        [BINDING.UAV_VIEW + 1, STAGE.COMPUTE, 'uniform'],
    ]);
});

test('a range of input registers indexed into is read out of an array of them, a range of'
    + ' outputs written through a switch (test_vs_input_relative_addressing)', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [0, 1, 2, 3].map(register=>({ name: 'COLOR', index: register, register })),
        outputs: [0, 1, 2].map(register=>({ name: 'COLOR', index: register, register })),
        instructions: [
            ...[0, 1, 2, 3].map(register=>dclInput(v(register))),
            ...[0, 1, 2].map(register=>dclOutput(o(register))),
            dclIndexRange(v(1), 3),
            dclIndexRange(o(1), 2),
            dclTemps(1),
            mov(r(0, 'x'), cb(0, 0, 'x')),
            mov(o(0), indexedBy(v(2), r(0, 'x'))),
            mov(indexedBy(o(1, 'xy'), r(0, 'x')), v(0)),
            ret(),
        ],
    }))));
    assert.deepEqual(vs.unsupported, []);
    const text = vs.body.filter(line=>typeof line === 'string').join('\n');
    assert.match(text, /var vr1 = array<vec4<u32>, 3>\(v1, v2, v3\);/);
    // v[r0.x + 2] is the range's second place on.
    assert.match(text, /o0 = vr1\[\(1u \+ r0\.x+\.x\)\]\.xyzw;/);
    assert.match(text, /switch \(r0\.x+\.x\) \{\s+case 0u: \{\s+let (held\d+) = held\d+;\s+o1\.x = \1\.x;\s+o1\.y = \1\.y;/);
    assert.match(text, /case 1u: \{\s+let held\d+ = held\d+;\s+o2\.x = /);
    assert.equal(vs.outputRegisters, 3);
});

test('a typed texture view an atomic touches is the words of its texels in a buffer, every'
    + ' access to it through them; early depth tests are the fragment\'s own', ()=>{
    const ps = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        major: 5,
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [
            dclGlobalFlags(1 | 4),
            dclUavTyped(1, RESOURCE_DIMENSION.TEXTURE2DARRAY, RETURN_TYPE.SINT),
            dclUavTyped(2, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT),
            dclOutput(o(0)),
            dclTemps(1),
            atomicIadd(u(1, 'x'), lu(3, 4, 5, 0), lu(1)),
            ldUavTyped(r(0, 'x'), lu(1, 2, 0, 0), u(1, 'xxxx')),
            storeUavTyped(u(1, 'xyzw'), lu(6, 7, 8, 0), r(0, 'xxxx')),
            storeUavTyped(u(2, 'xyzw'), lu(0, 0, 0, 0), r(0, 'xxxx')),
            mov(o(0), l(1, 1, 1, 1)),
            ret(),
        ],
    }))), { uavFormats: { 2: 'r32float' } });
    assert.deepEqual(ps.unsupported, []);
    assert.equal(ps.earlyDepth, true);
    assert.deepEqual(ps.uavs.map(uav=>!!uav.words), [true, false], 'only the one atomics touch');
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const linked = linkProgram(vs, ps, { earlyDepth: { compare: '<=', multisampled: false } });
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.fragment, /var<storage, read_write> u1: array<atomic<u32>>;/);
    assert.match(linked.fragment, /var u2: texture_storage_2d<r32float, write>;/);
    // Words a row, rows a layer, width, layers: layer z, row y, texel x.
    assert.match(linked.fragment, /return \(c\.z \* u1view\.y \+ c\.y\) \* u1view\.x \+ c\.x;/);
    assert.match(linked.fragment, /u1_atomic_iadd\(u1_index\(vec4<u32>\(vec4<u32>\(3u, 4u, 5u, 0u\)\.xyz,/);
    assert.match(linked.fragment, /if \(i >= arrayLength\(&u1\)\) \{ return 0u; \}/);
    assert.match(linked.fragment, /u1_load\(u1_index\(/);
    assert.match(linked.fragment, /u1_store\(u1_index\(/);
    assert.doesNotMatch(linked.fragment, /textureLoad\(u1|textureStore\(u1/);
    assert.match(linked.fragment, /var earlyDepth: texture_depth_2d;/);
    assert.match(linked.fragment, /if \(!\(in\.\w+\.z <= textureLoad\(earlyDepth,/);
    assert.deepEqual(linked.groups[1].filter(entry=>entry.binding === BINDING.EARLY_DEPTH
        || entry.binding === BINDING.UAV + 1 || entry.binding === BINDING.UAV_VIEW + 1)
        .map(entry=>entry.texture?.sampleType ?? entry.buffer?.type),
    ['storage', 'uniform', 'depth']);
});

test('a sampler\'s MipLODBias is added to every level the shader samples by: WebGPU\'s samplers'
    + ' have none (test_texture, d3d11.c:9385)', ()=>{
    const TEX = [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT), dclSampler(0)];
    const two = 'bitcast<f32>(1073741824u)';
    /** @param {any} instruction */
    const biased = instruction=>bodyOf(translate([instruction], { declarations: TEX,
        options: { samplerBias: { 0: 2 } } }));
    assert.match(biased(sample(r(0), v(0), t(0), s(0))),
        new RegExp(`textureSampleBias\\(t0, s0, [^;]*, ${two.replace(/[()]/g, '\\$&')}\\)`));
    assert.match(biased(sampleL(r(0), v(0), t(0), s(0), r(1, 'x'))),
        /textureSampleLevel\(t0, s0, [^;]*\.x \+ bitcast<f32>\(1073741824u\)\)/);
    assert.match(biased(sampleD(r(0), v(0), t(0), s(0), r(1), r(2))),
        /\* exp2\(bitcast<f32>\(1073741824u\)\)/);
    assert.doesNotMatch(bodyOf(translate([sample(r(0), v(0), t(0), s(0))], { declarations: TEX })),
        /Bias/, 'none without one');
});

test('a depth bias the fragment stage applies itself writes the rasterized depth plus the clamped'
    + ' bias, and leaves a shader-written depth alone (test_depth_bias, d3d11.c:28695)', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const ps = translateShader(/** @type {any} */ (parseDxbc(solidPixelShader([1, 0, 0, 1]))));
    const bias = { units: -(2 ** -14), slope: 2, clamp: -1e-5 };
    const linked = linkProgram(vs, ps, { depthBias: bias });
    assert.match(linked.fragment, /@builtin\(position\) biasPosition: vec4<f32>,/);
    assert.match(linked.fragment, /@builtin\(frag_depth\) depth: f32,/);
    assert.match(linked.fragment, new RegExp('let biasRaw = bitcast<f32>\\(3095396352u\\) \\+ '
        + 'bitcast<f32>\\(1073741824u\\) \\* max\\(abs\\(dpdx\\(biasZ\\)\\), '
        + 'abs\\(dpdy\\(biasZ\\)\\)\\);'));
    assert.match(linked.fragment, /let biasedDepth = biasZ \+ max\(biasRaw, /,
        'a negative clamp bounds a negative bias from below');
    assert.doesNotMatch(linkProgram(vs, ps).fragment, /frag_depth/, 'none without one');
    // No pixel shader bound: Direct3D still biases the depth it writes.
    const alone = linkProgram(vs, NO_PIXEL_SHADER,
        { depthBias: { units: -1e-3, slope: 0, clamp: 0 } });
    assert.match(alone.fragment, /return FragmentOut\(biasedDepth\);/);
});

test('a primitive\'s render target array index travels flat to the pixel stage, and a drawing'
    + ' of one layer keeps the fragments routed there, those past the views going to the first'
    + ' (test_layered_rendering, d3d11.c:11754)', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'POSITION', register: 0 }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'SV_RenderTargetArrayIndex', systemValue:
                SYSTEM_VALUE.RENDER_TARGET_ARRAY_INDEX, register: 1, mask: 0x1,
            componentType: COMPONENT_TYPE.UINT }],
        instructions: [dclInput(v(0)), dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            dclOutputSiv(o(1, 'x'), SYSTEM_VALUE.RENDER_TARGET_ARRAY_INDEX),
            mov(o(0), v(0)), mov(o(1, 'x'), v(0, 'x')), ret()],
    }))));
    const ps = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [{ name: 'SV_RenderTargetArrayIndex', systemValue:
            SYSTEM_VALUE.RENDER_TARGET_ARRAY_INDEX, register: 0, mask: 0x1,
        componentType: COMPONENT_TYPE.UINT }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [dclInputPsSiv(v(0, 'x'), SYSTEM_VALUE.RENDER_TARGET_ARRAY_INDEX),
            dclOutput(o(0)), mov(o(0), v(0)), ret()],
    }))));
    const whole = linkProgram(vs, ps);
    assert.deepEqual(whole.unsupported, []);
    assert.match(whole.vertex, /@location\(0\) @interpolate\(flat\) rtLayer: u32,/);
    assert.match(whole.fragment, /v0\.x = in\.rtLayer;/);
    assert.doesNotMatch(whole.fragment, /discard/);
    const second = linkProgram(vs, ps, { layerPass: { index: 1, count: 4 } });
    assert.match(second.fragment,
        /if \(in\.rtLayer != 1u && \(1u != 0u \|\| in\.rtLayer < 4u\)\) \{ discard; \}/);
    const unwritten = linkProgram(translateShader(/** @type {any} */ (parseDxbc(
        passThroughVertexShader()))), ps);
    assert.match(unwritten.fragment, /v0\.x = 0u;/, 'an index no vertex wrote reads zero');
});

test('the vertex ID counts neither the first vertex nor the base vertex: the vertex stage takes'
    + ' the draw\'s off its vertex index (test_vertex_id, d3d11.c:13910)', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'SV_VertexID', systemValue: SYSTEM_VALUE.VERTEX_ID, register: 0,
            mask: 0x1, componentType: COMPONENT_TYPE.UINT }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        instructions: [dclInputSiv(v(0, 'x'), SYSTEM_VALUE.VERTEX_ID),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION), utof(o(0), v(0, 'xxxx')), ret()],
    }))));
    const ps = translateShader(/** @type {any} */ (parseDxbc(solidPixelShader([0, 1, 0, 1]))));
    const linked = linkProgram(vs, ps, { vertexPull: { streams: [], attributes: [],
        vertexBase: true } });
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.vertex, /v0\.x = in\.vsVertexIndex - vsPulls\[0\]\.x;/);
    assert.ok(linked.groups[0].some(entry=>entry.binding === BINDING.VERTEX_PULL_PARAMS));
});

test('alpha to coverage on one sample keeps a fragment where the first target\'s alpha reaches'
    + ' half (test_alpha_to_coverage, d3d11.c:30988)', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const ps = translateShader(/** @type {any} */ (parseDxbc(solidPixelShader([0, 1, 0, 0.25]))));
    const covered = linkProgram(vs, ps, { alphaCoverage: true });
    assert.match(covered.fragment,
        /\{ if \(bitcast<f32>\(o0\.w\) < 0\.5\) \{ discard; \} return FragmentOut\(/);
    assert.doesNotMatch(linkProgram(vs, ps).fragment, /discard/);
});

test('a primitive\'s viewport index travels flat, and a drawing through one viewport keeps the'
    + ' fragments routed there (test_multiple_viewports, d3d11.c:31295)', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'POSITION', register: 0 }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 },
            { name: 'SV_ViewportArrayIndex', systemValue: SYSTEM_VALUE.VIEWPORT_ARRAY_INDEX,
                register: 1, mask: 0x1, componentType: COMPONENT_TYPE.UINT }],
        instructions: [dclInput(v(0)), dclOutputSiv(o(0), SYSTEM_VALUE.POSITION),
            dclOutputSiv(o(1, 'x'), SYSTEM_VALUE.VIEWPORT_ARRAY_INDEX),
            mov(o(0), v(0)), mov(o(1, 'x'), v(0, 'x')), ret()],
    }))));
    const ps = translateShader(/** @type {any} */ (parseDxbc(solidPixelShader([0, 1, 0, 1]))));
    const second = linkProgram(vs, ps, { viewportPass: { index: 1, count: 2 } });
    assert.deepEqual(second.unsupported, []);
    assert.match(second.vertex, /@interpolate\(flat\) rtViewport: u32,/);
    assert.match(second.fragment,
        /if \(in\.rtViewport != 1u\) \{ discard; \}/);
});

test('lod is the longer footprint\'s log2 in texels of level 0 plus the sampler\'s bias: x held'
    + ' to the levels, y not', ()=>{
    /** @param {number} dimension @param {object} [options] */
    const lodOf = (dimension, options)=>translate([lod(r(0), v(0), t(0, 'yxzw'), s(0))], {
        declarations: [dclResource(0, dimension, RETURN_TYPE.FLOAT), dclSampler(0)], options });
    const flat = lodOf(RESOURCE_DIMENSION.TEXTURE2D);
    assert.deepEqual(flat.unsupported, []);
    assert.equal(bodyOf(flat), [
        `let held0 = ${F}(v0.xyzw);`,
        'let held1 = dpdx(held0.xy) * vec2<f32>(textureDimensions(t0, 0));',
        'let held2 = dpdy(held0.xy) * vec2<f32>(textureDimensions(t0, 0));',
        'let held3 = 0.5 * log2(max(dot(held1, held1), dot(held2, held2)));',
        `r0 = ${U}(vec4<f32>(clamp(held3, 0.0, f32(textureNumLevels(t0) - 1u)), held3,`
            + ' 0.0, 0.0)).yxzw;',
    ].join('\n'));
    const biased = bodyOf(lodOf(RESOURCE_DIMENSION.TEXTURE2DARRAY, { samplerBias: { 0: -1 } }));
    assert.match(biased, /dot\(held2, held2\)\)\) \+ bitcast<f32>\(3212836864u\);/);
    assert.match(bodyOf(lodOf(RESOURCE_DIMENSION.TEXTURE1DARRAY)),
        /held1 = vec2<f32>\(dpdx\(held0\.x\) \* f32\(textureDimensions\(t0, 0\)\.x\), 0\.0\);/);
    assert.match(bodyOf(lodOf(RESOURCE_DIMENSION.TEXTURE3D)),
        /held2 = dpdy\(held0\.xyz\) \* vec3<f32>\(textureDimensions\(t0, 0\)\);/);
    const cube = lodOf(RESOURCE_DIMENSION.TEXTURECUBE);
    assert.ok(cube.helpers.includes('cubeFaceSlope'));
    assert.match(bodyOf(cube), new RegExp('held1 = cubeFaceSlope\\(held0\\.xyz, dpdx\\(held0'
        + '\\.xyz\\)\\) \\* \\(0\\.5 \\* f32\\(textureDimensions\\(t0, 0\\)\\.x\\)\\);'));
    assert.deepEqual(translate([lod(r(0), v(0), t(0), s(0))], { kind: SHADER_KIND.VERTEX,
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT)] })
        .unsupported, ['lod outside a pixel shader']);
});

test('a cube\'s face slope is d(minor / major) on the longest axis, x before y before z', ()=>{
    const text = HELPERS.cubeFaceSlope.text.join('\n');
    assert.match(text, /return \(slid \* major - minor \* moved\) \/ \(major \* major\);/);
    assert.match(text, /if \(a\.x >= a\.y && a\.x >= a\.z\) \{ major = c\.x; moved = d\.x;/);
    assert.match(text, /else if \(a\.y >= a\.z\) \{ major = c\.y; moved = d\.y;/);
});

test('eval_* carry an input along its slopes to the sample or the snapped offset; the centroid'
    + ' of a pixel drawn whole is its own value', ()=>{
    assert.equal(emitted([evalCentroid(r(0), v(1, 'zyxw'))]), 'r0 = v1.zyxw;');
    const indexed = translate([evalSampleIndex(r(0), v(1), r(2, 'xxxx'))]);
    assert.equal(indexed.rasterizerSamples, true);
    assert.ok(indexed.helpers.includes('samplePosition'));
    assert.equal(bodyOf(indexed), [
        `let held0 = ${F}(v1.xyzw);`,
        'let held1 = samplePosition(rasterSamples, r2.xxxx.x);',
        `r0 = ${U}(held0 + dpdx(held0) * held1.x + dpdy(held0) * held1.y);`,
    ].join('\n'));
    assert.match(emitted([evalSnapped(r(0), v(1), r(2))]),
        /let held1 = vec2<f32>\(\(bitcast<vec4<i32>>\(r2\.xyzw\)\.xy << vec2<u32>\(28u\)\) >> vec2<u32>\(28u\)\) \/ 16\.0;/);
    assert.match(bodyOf(translate([{ ...evalSnapped(r(0), v(1), r(2)), saturate: true }])),
        /clamp\(held0 \+ dpdx\(held0\)/);
    assert.deepEqual(translate([evalCentroid(r(0), v(1))], { kind: SHADER_KIND.VERTEX })
        .unsupported, ['eval_centroid outside a pixel shader']);
});

test('fcall writes the body the bound instance\'s table names for the call site; this reads the'
    + ' instance\'s words; a pointer array indexed at run time is a switch', ()=>{
    // Two classes, two call sites each: ft0 = { fb0, fb1 }, ft1 = { fb2, fb3 };
    // fp0 is one pointer, fp1 an array of two, both taking either class.
    const declarations = [dclFunctionBody(0), dclFunctionBody(1), dclFunctionBody(2),
        dclFunctionBody(3), dclFunctionTable(0, [0, 1]), dclFunctionTable(1, [2, 3]),
        dclInterface(0, 1, 2, [0, 1]), dclInterface(1, 2, 2, [0, 1])];
    const bodies = [ret(), functionBody(0), mov(r(0), l(0, 0, 0, 0)), ret(),
        functionBody(1), mov(r(0), l(1, 1, 1, 1)), ret(), functionBody(2),
        mov(r(0), thisPointer(0, 'yyyy')), ret(), functionBody(3), mov(r(0), thisPointer(2))];
    /** @param {any[]} body @param {any} interfaces */
    const linked = (body, interfaces)=>translate([...body, ...bodies],
        { declarations, options: { interfaces } });
    const instances = [{ table: 1, data: [5, 6, 7, 8] }, { table: 0, data: [9, 9, 9, 9] },
        { table: 1, data: [1, 2, 3, 4] }];
    const direct = linked([fcall(0, 0, 0), fcall(1, 1, 1)], instances);
    assert.deepEqual(direct.unsupported, []);
    // fp0 holds ft1: its site 0 is fb2, which reads this[0].y; fp1[1] is slot
    // 2, ft1 again: site 1 is fb3, which reads this[2] whole.
    assert.equal(bodyOf(direct), 'r0 = vec4<u32>(5u, 6u, 7u, 8u).yyyy;\n'
        + 'r0 = vec4<u32>(1u, 2u, 3u, 4u).xyzw;');
    const computed = bodyOf(linked([fcall(0, 1, 0, r(3, 'x'))], instances));
    assert.equal(computed, ['switch (r3.xxxx.x) {', 'case 0u: {', 'r0 = vec4<u32>(0u, 0u, 0u, 0u);',
        '}', 'case 1u: {', 'r0 = vec4<u32>(5u, 6u, 7u, 8u).yyyy;', '}', 'default: {}', '}']
        .join('\n'));
    const unbound = linked([fcall(0, 0, 0)], [null]);
    assert.deepEqual([unbound.unsupported, unbound.unboundInterfaces, bodyOf(unbound)],
        [[], [0], 'RET'], 'the call does nothing');
    assert.deepEqual(linked([fcall(0, 0, 0)], undefined).unsupported,
        ['an interface call, with no class instances given']);
    assert.deepEqual(linked([fcall(0, 0, 0)], [{ table: 7, data: [0, 0, 0, 0] }]).unsupported,
        ['class instance table 7 at slot 0, which its interface does not take']);
});

test('a double instruction works on .xy and .zw as doubles, the source swizzled first, a'
    + ' modifier on each double\'s sign; only the doubles the mask writes are worked', ()=>{
    const both = translate([dadd(r(0), r(1, 'zwxy'), modified(r(2), MODIFIER.NEG))]);
    assert.deepEqual(both.unsupported, []);
    assert.ok(both.helpers.includes('dblAdd') && both.helpers.indexOf('u64')
        < both.helpers.indexOf('dblAdd'), 'the helpers, callees first');
    assert.equal(bodyOf(both), [
        'let held0 = r1.zwxy;',
        'let held1 = (r2.xyzw ^ vec4<u32>(0u, 0x80000000u, 0u, 0x80000000u));',
        'r0 = vec4<u32>(dblAdd(held0.xy, held1.xy), dblAdd(held0.zw, held1.zw));',
    ].join('\n'));
    assert.match(emitted([dmul(r(0, 'zw'), modified(r(1), MODIFIER.ABS), r(2))]),
        /held2 = vec4<u32>\(vec2<u32>\(0u\), dblMul\(held0\.zw, held1\.zw\)\);\nr0\.z = held2\.z;\nr0\.w = held2\.w;/);
    assert.match(emitted([dfma(r(0, 'xy'), r(1), r(2), r(3))]),
        /dblFma\(held0\.xy, held1\.xy, held2\.xy\), vec2<u32>\(0u\)\)/);
    assert.match(emitted([drcp(r(0), r(1))]), /dblDiv\(vec2<u32>\(0u, 0x3ff00000u\), held0\.zw\)/);
    assert.match(emitted([dmovc(r(0), r(1), r(2), r(3))]),
        /select\(held2\.xy, held1\.xy, held0\.x != 0u\), select\(held2\.zw, held1\.zw, held0\.y != 0u\)/);
    assert.match(bodyOf(translate([{ ...dmax(r(0), r(1), r(2)), saturate: true }])),
        /dblSaturate\(dblMax\(held0\.xy, held1\.xy\)\)/);
    assert.equal(emitted([dmov(r(0), dl(1, -2))]),
        'let held0 = vec4<u32>(0u, 1072693248u, 0u, 3221225472u);\n'
        + 'r0 = vec4<u32>(held0.xy, held0.zw);');
});

test('a double comparison or conversion to a dword writes the first double to the mask\'s first'
    + ' component, the second to its second; a dword makes a double by place', ()=>{
    assert.match(emitted([deq(r(0, 'yw'), r(1), r(2))]),
        /vec4<u32>\(0u, select\(0u, 0xffffffffu, dblEqual\(held0\.xy, held1\.xy\)\), 0u, select\(0u, 0xffffffffu, dblEqual\(held0\.zw, held1\.zw\)\)\)/);
    assert.match(emitted([dge(r(0, 'x'), r(1), r(2))]),
        /!\(dblNan\(held0\.xy\) \|\| dblNan\(held1\.xy\) \|\| dblLess\(held0\.xy, held1\.xy\)\)/);
    assert.match(emitted([dne(r(0, 'x'), r(1), r(2))]), /!dblEqual\(held0\.xy, held1\.xy\)/);
    assert.match(emitted([dlt(r(0, 'z'), r(1), r(2))]),
        /vec4<u32>\(0u, 0u, select\(0u, 0xffffffffu, dblLess\(held0\.xy, held1\.xy\)\), 0u\)/);
    const converted = translate([dtof(r(0, 'xy'), r(1)), dtoi(r(2, 'x'), r(1, 'zwzw')),
        dtou(r(3, 'x'), r(1))]);
    assert.ok(converted.helpers.includes('dblConvert'));
    assert.match(bodyOf(converted),
        /vec4<u32>\(dblToFloat\(held0\.xy\), dblToFloat\(held0\.zw\), 0u, 0u\)/);
    assert.match(bodyOf(converted), /dblToInt\(held\d\.xy\)/);
    assert.match(bodyOf(converted), /dblToUint\(held\d\.xy\)/);
    assert.equal(emitted([ftod(r(0), r(1, 'yxzw'))]),
        'let held0 = r1.yxzw;\nr0 = vec4<u32>(dblFromFloat(held0.x), dblFromFloat(held0.y));');
    assert.match(emitted([itod(r(0, 'zw'), r(1))]),
        /vec4<u32>\(vec2<u32>\(0u\), dblFromInt\(held0\.y\)\)/);
    assert.match(emitted([utod(r(0, 'xy'), r(1))]),
        /vec4<u32>\(dblFromUint\(held0\.x\), vec2<u32>\(0u\)\)/);
    assert.match(emitted([ftod(r(0), modified(r(1), MODIFIER.NEG))]),
        /let held0 = bitcast<vec4<u32>>\(\(-bitcast<vec4<f32>>\(r1\.xyzw\)\)\);/);
});

test('sampleinfo and samplepos read the rasterizer\'s sample count, fixed at link, or the'
    + ' texture\'s, and the standard positions (test_sampleinfo_instruction, d3d11.c:24561)',
()=>{
    const MS = [dclResource(0, RESOURCE_DIMENSION.TEXTURE2DMS, RETURN_TYPE.FLOAT)];
    const info = translate([sampleInfo(r(0), rasterizer()), sampleInfo(r(1), t(0), true)],
        { declarations: MS, options: { multisampled: [0] } });
    assert.equal(info.rasterizerSamples, true);
    assert.match(bodyOf(info), /r0 = vec4<u32>\(bitcast<u32>\(f32\(rasterSamples\)\), 0u, 0u, 0u\)/);
    assert.match(bodyOf(info), /r1 = vec4<u32>\(textureNumSamples\(t0\), 0u, 0u, 0u\)/);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    assert.match(linkProgram(vs, info, { sampleCount: 4 }).fragment,
        /const rasterSamples: u32 = 4u;/);
    const position = translate([samplePos(r(0), rasterizer(), l(1, 1, 1, 1))]);
    assert.ok(position.helpers.includes('samplePosition'));
    assert.match(bodyOf(position), /samplePosition\(rasterSamples, /);
});

test('a pixel input is interpolated as declared, at its centroid or each sample, with or without'
    + ' perspective, both stages alike; SV_SampleIndex is the sample shaded'
    + ' (test_sample_shading, d3d11.c:31751)', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(colouredVertexShader())));
    /** @param {number} mode */
    const linked = mode=>linkProgram(vs, translateShader(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [{ name: 'COLOR', register: 1 }, { name: 'SV_SampleIndex', systemValue:
            SYSTEM_VALUE.SAMPLE_INDEX, register: 2, mask: 0x1, componentType:
            COMPONENT_TYPE.UINT }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [dclInputPs(v(1), mode), dclInputPsSgv(v(2, 'x'), SYSTEM_VALUE.SAMPLE_INDEX),
            dclOutput(o(0)), mov(o(0), v(1)), ret()],
    })))));
    const sampled = linked(6);
    assert.deepEqual(sampled.unsupported, []);
    assert.match(sampled.vertex, /@location\(0\) @interpolate\(perspective, sample\) o1/);
    assert.match(sampled.fragment, /@location\(0\) @interpolate\(perspective, sample\) v1/);
    assert.match(sampled.fragment, /@builtin\(sample_index\) v2: u32,/);
    assert.match(linked(5).fragment, /@interpolate\(linear, centroid\) v1/);
    assert.match(linked(2).fragment, /@location\(0\) v1: vec4<f32>/);
});

test('a target\'s output takes the target\'s scalar, the shader\'s bits as they are'
    + ' (d3d10core.c test_layered_rtv_mismatch)', ()=>{
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    const ps = translateShader(/** @type {any} */ (parseDxbc(solidPixelShader([0, 1, 0, 1]))));
    const asFloat = linkProgram(vs, ps).fragment;
    assert.match(asFloat, /@location\(0\) target0: vec4<f32>/);
    const asUint = linkProgram(vs, ps, { targets: [0], targetScalars: { 0: 'u32' } }).fragment;
    assert.match(asUint, /@location\(0\) target0: vec4<u32>/,
        'a float output written to an integer target keeps its bits');
});
