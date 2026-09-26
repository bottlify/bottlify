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
import { BINDING, HELPERS, STAGE, linkProgram, translateShader } from './wgsl.js';
import {
    add, addSat, and, assemble, breakOut, breakcNz, call, callcNz, caseOf, cb,
    colouredPixelShader, colouredVertexShader, defaultCase, endswitch, label, switchOn,
    dclConstantBuffer, dclIndexableTemp, dclInput, dclInputPs, dclInputPsSiv, dclInputSiv,
    dclOutput, dclOutputSiv, dclResource, dclSampler, dclTemps, discardNz, div, dp3, dp4,
    elseBranch, endif, endloop, eq, exp, frc, ftoi, ftou, gather4, ge, iadd, ieq, ifNz, ifZ, ige,
    ilt, imad, ldMs, resinfoRcp, sampleD,
    imul,
    immediateConstantBuffer, indexedBy, ineg, ishl, ishr, itof, l, ld, log, loop, lt, lu, mad, max,
    min, modified, mov, movc, mul, ne, not, nullDest, o, oDepth, or, passThroughVertexShader,
    r, resinfo, ret, retcNz, roundNe, roundNi, rsq, s, sample, sampleCLz, sampleL, sincos,
    solidPixelShader, sqrt, t, udiv, ult, umax, umin, umul, ushr, utof, v, xor,
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
    return translateShader(parsed);
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
    assert.equal(emitted([mov(r(0), modified(r(1), MODIFIER.ABSNEG))]),
        'r0 = (-abs(r1.xyzw));');
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
    assert.equal(emitted([ftoi(r(0), r(1))]), `r0 = ${U}(vec4<i32>(${F}(r1.xyzw)));`);
    assert.equal(emitted([ftou(r(0), r(1))]), `r0 = vec4<u32>(${F}(r1.xyzw));`);
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
        ['a call to label 4, which the program does not have']);
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
            buffer: { type: 'uniform' } },
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

test('ld fetches a texel by integer address with the level in w', ()=>{
    const translated = translate([ld(r(0), r(1), t(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.UINT)],
    });
    assert.equal(bodyOf(translated),
        `r0 = (textureLoad(t0, ${I}(r1.xyzw).xy, ${I}(r1.xyzw).w)).xyzw;`);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    assert.match(linkProgram(vs, translated).fragment, /var t0: texture_2d<u32>;/);
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
    assert.equal(bodyOf(loaded), `r0 = ${U}((textureLoad(t0, vec2<i32>(${I}(r1.xyzw).x, 0), `
        + `${I}(r1.xyzw).w)).xyzw);`);
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
    assert.equal(bodyOf(translated), `r0 = select(${U}((textureLoad(t0, ${I}(r1.xyzw).xy, 0))`
        + '.xyzw), vec4<u32>(0u), r2.xxxx.x != 0u);');
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    assert.match(linkProgram(vs, translated).fragment, /var t0: texture_2d<f32>;/);
    const plain = translate([ld(r(0), r(1), t(0))], {
        declarations: [dclResource(0, RESOURCE_DIMENSION.TEXTURE2DMSARRAY, RETURN_TYPE.FLOAT)],
    });
    assert.equal(bodyOf(plain), `r0 = ${U}((textureLoad(t0, ${I}(r1.xyzw).xy, `
        + `${I}(r1.xyzw).z, 0)).xyzw);`);
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

test('an instruction with no translation is named, and nothing plausible is emitted', ()=>{
    const translated = translate([{ opcode: 108, operands: [r(0), r(1), t(0), s(0)] }],
        { declarations: TEXTURE });
    assert.deepEqual(translated.unsupported, ['lod']);
    const vs = translateShader(/** @type {any} */ (parseDxbc(passThroughVertexShader())));
    assert.ok(linkProgram(vs, translated).unsupported.includes('lod'),
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

test('a varying is matched by semantic, not by register', ()=>{
    // The vertex shader writes COLOR in o1; a pixel shader that reads it in v3
    // still finds it, at the location the vertex output was given.
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
