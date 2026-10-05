/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from './hlsl-parser.js';
import { check } from './hlsl-check.js';
import { typeToString } from './hlsl-types.js';

/** @param {string} source @param {{ entry?: string, rowMajor?: boolean }} [options] */
function compile(source, options){
    const program = parse(source);
    return { program, ...check(program, options) };
}

/** @param {string} source @param {{ entry?: string }} [options] */
function errors(source, options){
    return compile(source, options).diagnostics.filter(d=>d.severity === 'error')
        .map(d=>`${d.code}: ${d.message}`);
}

/** @param {string} source @param {{ entry?: string }} [options] */
function warnings(source, options){
    return compile(source, options).diagnostics.filter(d=>d.severity === 'warning')
        .map(d=>`${d.code}: ${d.message}`);
}

/**
 * The checked expression of `void f(){ <expression>; }` after the declarations.
 *
 * @param {string} decls @param {string} expression
 * @returns {any}
 */
function exprOf(decls, expression){
    const r = compile(`${decls}\nvoid f(){ ${expression}; }`);
    assert.deepEqual(r.diagnostics.filter(d=>d.severity === 'error'), [], expression);
    const fn = /** @type {any} */ (r.program.decls.at(-1));
    return fn.body.stmts[0].expr;
}

/** @param {string} decls @param {string} expression */
function typeOfExpr(decls, expression){
    return typeToString(exprOf(decls, expression).type);
}

const DECLS = `
struct S { float a; float3 b; int c; };
struct T { S s; float4 w[2]; };
static float f1; static float2 f2; static float3 f3; static float4 f4; static int i1;
static int3 i3; static bool b1; static bool3 b3;
static float3x3 m33; static float4x4 m44; static float2x3 m23; static int2x2 im22;
static float arr[4]; static float3 varr[2]; static S st; static T tt; static float2x2 marr[2];
sampler2D samp; samplerCUBE cube; sampler any;
`;

test('expression types: literals, operators, conversions', ()=>{
    /** @type {[string, string][]} */
    const cases = [
        ['1', 'int'], ['1.5', 'float'], ['1.5f', 'float'], ['2.0h', 'float'], ['7u', 'int'],
        ['true', 'bool'], ['f1 + 1', 'float'], ['i1 + 1', 'int'], ['i1 + 1.0', 'float'],
        ['f3 + 1', 'float3'], ['1 + f3', 'float3'], ['i3 * 2', 'int3'], ['i3 * 2.0', 'float3'],
        ['f3 * f3', 'float3'], ['f4 + f3', 'float3'], ['f3 + f4', 'float3'], ['f2 / f1', 'float2'],
        ['m33 * m33', 'float3x3'], ['m33 * 2', 'float3x3'], ['m33 + m44', 'float3x3'],
        ['f1 < 2', 'bool'], ['f3 < f3', 'bool3'], ['i3 == 1', 'bool3'], ['b1 == b1', 'bool'],
        ['f3 >= f4', 'bool3'], ['m33 < 1', 'bool3x3'], ['!f3', 'bool3'], ['!b1', 'bool'],
        ['f1 && b1', 'bool'], ['f3 || f3', 'bool3'], ['f3 && f1', 'bool3'],
        ['-f3', 'float3'], ['-b1', 'int'], ['-i3', 'int3'], ['+m33', 'float3x3'],
        ['i1 & 3', 'int'], ['i3 | i3', 'int3'], ['i1 << 2', 'int'], ['i1 >> i1', 'int'],
        ['i1 ^ b1', 'int'], ['~i3', 'int3'], ['b3 & b3', 'int3'],
        ['i1 % 3', 'int'], ['f1 % 3', 'float'], ['f3 % 2', 'float3'],
        ['b1 + b1', 'int'], ['b1 + 1.5', 'float'],
        ['b1 ? f3 : f3', 'float3'], ['b1 ? 1 : 2.0', 'float'], ['b1 ? f3 : 1', 'float3'],
        ['b1 ? i3 : f3', 'float3'], ['b1 ? st : st', 'S'], ['f1 ? 1 : 0', 'int'],
        ['(f1, i3)', 'int3'], ['f1 = 2', 'float'], ['f3 += 1', 'float3'],
    ];
    for (const [expression, expected] of cases)
    {
        assert.equal(typeOfExpr(DECLS, expression), expected, expression);
    }
});

test('assignments yield the type of the target', ()=>{
    const d = 'struct S { float a; float3 b; int c; };\n'
        + 'void g(){ float f1; float3 f3; int i1; int3 i3; S st;';
    for (const [expression, expected] of [['f1 = 2', 'float'], ['f3 += 1', 'float3'],
        ['i1 = 2.5', 'int'], ['f3 = f1', 'float3'], ['f1 = f3', 'float'], ['i3 *= 2.5', 'int3'],
        ['f3.xy = f1', 'float2'], ['f3 -= f3.zyx', 'float3'], ['i1 <<= 2', 'int'],
        ['f1 %= 3', 'float'], ['st.b = f3', 'float3'], ['st.a++', 'float'], ['--i1', 'int']])
    {
        const r = compile(`${d} ${expression}; }`);
        assert.deepEqual(r.diagnostics.filter(x=>x.severity === 'error'), [], expression);
        const fn = /** @type {any} */ (r.program.decls.at(-1));
        assert.equal(typeToString(fn.body.stmts.at(-1).expr.type), expected, expression);
    }
});

test('member access: swizzles', ()=>{
    /** @type {[string, string][]} */
    const cases = [
        ['f4.x', 'float'], ['f4.xy', 'float2'], ['f4.xyz', 'float3'], ['f4.wzyx', 'float4'],
        ['f4.rgba', 'float4'], ['f4.rg', 'float2'], ['f4.xxxx', 'float4'], ['f2.yx', 'float2'],
        ['f3.zzz', 'float3'], ['i3.xy', 'int2'], ['b3.z', 'bool'], ['f1.x', 'float'],
        ['f1.xxx', 'float3'], ['f1.rr', 'float2'], ['i1.xxxx', 'int4'],
        ['m33._11', 'float'], ['m33._m00', 'float'], ['m33._11_22_33', 'float3'],
        ['m33._m00_m11_m22', 'float3'], ['m44._m03_m13', 'float2'], ['m44._44', 'float'],
        ['m23._13', 'float'], ['m23._m12', 'float'], ['im22._22', 'int'],
        ['f4.xy.x', 'float'], ['(f4 + f4).zw', 'float2'], ['m44._14_24_34_44', 'float4'],
    ];
    for (const [expression, expected] of cases)
    {
        assert.equal(typeOfExpr(DECLS, expression), expected, expression);
    }
    assert.deepEqual(exprOf(DECLS, 'f4.wzyx').swizzle, [3, 2, 1, 0]);
    assert.deepEqual(exprOf(DECLS, 'f4.rgb').swizzle, [0, 1, 2]);
    assert.deepEqual(exprOf(DECLS, 'f1.xxx').swizzle, [0, 0, 0]);
    assert.deepEqual(exprOf(DECLS, 'm33._m12_m21').matrixSwizzle, [[1, 2], [2, 1]]);
    assert.deepEqual(exprOf(DECLS, 'm33._12_21').matrixSwizzle, [[0, 1], [1, 0]]);
});

test('member access: structures, indexing', ()=>{
    /** @type {[string, string][]} */
    const cases = [
        ['st.a', 'float'], ['st.b', 'float3'], ['st.c', 'int'], ['tt.s', 'S'],
        ['tt.s.b', 'float3'], ['tt.s.b.xy', 'float2'], ['tt.w', 'float4[2]'],
        ['tt.w[1]', 'float4'], ['tt.w[1].z', 'float'], ['arr[2]', 'float'], ['arr', 'float[4]'],
        ['varr[1]', 'float3'], ['varr[1].y', 'float'], ['f4[2]', 'float'], ['i3[0]', 'int'],
        ['m33[1]', 'float3'], ['m23[1]', 'float3'], ['m33[1][2]', 'float'],
        ['marr[1][0]', 'float2'], ['arr[i1]', 'float'], ['arr[1.5]', 'float'],
    ];
    for (const [expression, expected] of cases)
    {
        assert.equal(typeOfExpr(DECLS, expression), expected, expression);
    }
    const member = exprOf(DECLS, 'tt.s.b');
    assert.equal(member.field, 1);
    assert.equal(member.fieldName, 'b');
    assert.equal(member.object.field, 0);
    assert.equal(exprOf(DECLS, 'st.c').field, 2);
});

test('indexing a float index converts it to int', ()=>{
    const e = exprOf(DECLS, 'arr[1.5]');
    assert.equal(e.index.kind, 'cast');
    assert.equal(e.index.implicit, true);
    assert.equal(typeToString(e.index.type), 'int');
});

test('constructors and casts', ()=>{
    /** @type {[string, string][]} */
    const cases = [
        ['float4(1, 2, 3, 4)', 'float4'], ['float4(f3, 1)', 'float4'], ['float4(f2, f2)', 'float4'],
        ['float4(f1, f3)', 'float4'], ['float3(f4.xyz)', 'float3'], ['float2(1, 2)', 'float2'],
        ['float4(1)', 'float4'], ['float3x3(1, 2, 3, 4, 5, 6, 7, 8, 9)', 'float3x3'],
        ['float2x2(f2, f2)', 'float2x2'], ['float2x2(f4)', 'float2x2'],
        ['float4x4(m44)', 'float4x4'], ['float3x3(f3, f3, f3)', 'float3x3'],
        ['int3(f3)', 'int3'], ['bool2(1, 0)', 'bool2'], ['float(1)', 'float'],
        ['float1(2)', 'float1'], ['half4(1, 2, 3, 4)', 'float4'],
        ['(vector<int, 2>(1, 2))', 'int2'],
        ['(matrix<float, 2, 2>(1, 2, 3, 4))', 'float2x2'], ['float2x3(m23)', 'float2x3'],
        ['(float3)f4', 'float3'], ['(float)f3', 'float'], ['(float4)f1', 'float4'],
        ['(int)f1', 'int'], ['(float3x3)m44', 'float3x3'], ['(float2x2)f4', 'float2x2'],
        ['(float4)m22', 'float4'], ['(bool)i1', 'bool'], ['(S)st', 'S'],
        ['(int2x2)m22', 'int2x2'], ['(S)0', 'S'], ['(S)f1', 'S'],
    ];
    for (const [expression, expected] of cases)
    {
        const decl = `${DECLS}\nfloat2x2 m22;`;
        assert.equal(typeOfExpr(decl, expression), expected, expression);
    }
    const ctor = exprOf(DECLS, 'float4(f2, 1, f1)');
    assert.deepEqual(ctor.argScalars, [2, 1, 1]);
    assert.equal(ctor.replicate, false);
    assert.equal(exprOf(DECLS, 'float4(1)').replicate, true);
    assert.equal(ctor.typeRef.cls, 'vector');
    const cast = exprOf(DECLS, '(float3)f4');
    assert.equal(cast.implicit, false);
    assert.equal(typeToString(cast.type), 'float3');
    assert.equal(cast.typeRef.cls, 'vector');
});

test('implicit conversions are explicit cast nodes', ()=>{
    const add = exprOf(DECLS, 'f3 + 1');
    assert.equal(add.kind, 'binary');
    assert.equal(typeToString(add.opType), 'float3');
    assert.equal(add.left.kind, 'ident');
    assert.equal(add.right.kind, 'cast');
    assert.equal(add.right.implicit, true);
    assert.equal(typeToString(add.right.type), 'float3');
    assert.equal(add.right.operand.kind, 'num');
    const mixed = exprOf(DECLS, 'i1 * 2.5');
    assert.equal(mixed.left.kind, 'cast');
    assert.equal(typeToString(mixed.left.type), 'float');
    assert.equal(mixed.right.kind, 'num');
    const cmp = exprOf(DECLS, 'i3 < f3');
    assert.equal(typeToString(cmp.opType), 'float3');
    assert.equal(typeToString(cmp.type), 'bool3');
    assert.equal(cmp.left.kind, 'cast');
    const eq = exprOf(DECLS, 'f1 = i1');
    assert.equal(eq.value.kind, 'cast');
    assert.equal(typeToString(eq.value.type), 'float');
    const same = exprOf(DECLS, 'f1 = f1');
    assert.equal(same.value.kind, 'ident');
});

test('operators record the type of their operands', ()=>{
    const bits = exprOf(DECLS, 'i1 & 3');
    assert.equal(bits.integerOnly, true);
    assert.equal(exprOf(DECLS, 'i1 + 3').integerOnly, undefined);
    const compound = exprOf(DECLS, 'f3 += f4');
    assert.equal(typeToString(compound.opType), 'float3');
    assert.equal(typeToString(compound.type), 'float3');
    assert.equal(typeToString(compound.value.type), 'float3');
    const shift = exprOf(DECLS, 'i1 <<= 2');
    assert.equal(shift.integerOnly, true);
    const un = exprOf(DECLS, '-b1');
    assert.equal(typeToString(un.opType), 'int');
    assert.equal(un.operand.kind, 'cast');
    const not = exprOf(DECLS, '!f3');
    assert.equal(typeToString(not.opType), 'bool3');
    const logic = exprOf(DECLS, 'f1 && f3');
    assert.equal(typeToString(logic.opType), 'bool3');
    assert.equal(logic.left.kind, 'cast');
    const cond = exprOf(DECLS, 'f1 ? i1 : f3');
    assert.equal(cond.test.kind, 'cast');
    assert.equal(typeToString(cond.test.type), 'bool');
    assert.equal(typeToString(cond.type), 'float3');
    assert.equal(cond.then.kind, 'cast');
    assert.equal(cond.else.kind, 'ident');
    const inc = exprOf(DECLS, 'i1++');
    assert.equal(typeToString(inc.opType), 'int');
    assert.equal(inc.prefix, false);
});

test('names resolve to symbols', ()=>{
    const r = compile(`${DECLS}
float4 g(float4 p : POSITION, uniform float s, out float o){
    float4 local = p * s;
    o = local.x;
    return local;
}`);
    assert.deepEqual(r.diagnostics, []);
    const fn = /** @type {any} */ (r.program.decls.at(-1));
    const decl = fn.body.stmts[0].vars[0];
    assert.equal(decl.sym.kind, 'local');
    assert.equal(decl.sym.name, 'local');
    const mul = decl.init;
    assert.equal(mul.left.sym.kind, 'param');
    assert.equal(mul.left.sym.semantic, 'POSITION');
    assert.equal(mul.right.operand.sym.isUniform, true);
    assert.equal(mul.left.sym.isUniform, false);
    assert.equal(fn.body.stmts[1].expr.target.sym.dir, 'out');
    const ids = new Set();
    for (const g of r.module.globals)
    {
        ids.add(g.id);
    }
    assert.equal(ids.size, r.module.globals.length);
});

test('globals: uniform unless static; register and semantic; constants', ()=>{
    const r = compile(`
float4x4 wvp : register(c0);
const float k = 2;
static float s = 1;
static const int N = 4;
static const float2 half2 = float2(0.5, 0.5);
static const float derived = N * 2.5;
float4 colour : COLOR0;
sampler2D samp : register(s1);
float table[N];
`);
    assert.deepEqual(r.diagnostics, []);
    const by = Object.fromEntries(r.module.globals.map(g=>[g.name, g]));
    assert.equal(by.wvp.isUniform, true);
    assert.deepEqual(by.wvp.register, { profile: null, name: 'c0' });
    assert.equal(by.k.isUniform, true);
    assert.equal(by.k.isConst, true);
    assert.equal(by.k.constValue, undefined);
    assert.equal(by.s.isUniform, false);
    assert.equal(by.s.isStatic, true);
    assert.equal(by.s.constValue, undefined);
    assert.equal(by.N.constValue, 4);
    assert.deepEqual(by.half2.constValue, [0.5, 0.5]);
    assert.equal(by.derived.constValue, 10);
    assert.equal(by.colour.semantic, 'COLOR0');
    assert.equal(typeToString(by.samp.type), 'sampler2D');
    assert.equal(typeToString(by.table.type), 'float[4]');
    assert.deepEqual(r.module.globals.map(g=>g.name),
        ['wvp', 'k', 's', 'N', 'half2', 'derived', 'colour', 'samp', 'table']);
});

test('only the globals an entry point names are checked', ()=>{
    const src = `
float bad = undefined_name;
float good = 3;
float use(){ return good; }
float main(){ return use(); }
`;
    assert.deepEqual(errors(src, { entry: 'main' }), []);
    assert.deepEqual(errors(src), ["X3004: undeclared identifier 'undefined_name'"]);
    const r = compile(src, { entry: 'main' });
    const by = Object.fromEntries(r.module.globals.map(g=>[g.name, g]));
    assert.ok(by.good.init);
    assert.equal(by.bad.init, null);
});

test('sampler_state entries are kept as text; cbuffer members are globals', ()=>{
    const r = compile(`
texture tex0;
sampler s0 = sampler_state { Texture = <tex0>; MinFilter = LINEAR; AddressU = Clamp;
    MaxAnisotropy = 4; sRGBTexture = false; };
cbuffer Frame : register(b0) { float4 a; float b; };
`);
    assert.deepEqual(r.diagnostics, []);
    const s0 = r.module.globals.find(g=>g.name === 's0');
    assert.deepEqual(s0?.samplerState, [
        { name: 'Texture', valueText: 'tex0' }, { name: 'MinFilter', valueText: 'LINEAR' },
        { name: 'AddressU', valueText: 'Clamp' }, { name: 'MaxAnisotropy', valueText: '4' },
        { name: 'sRGBTexture', valueText: 'false' }]);
    assert.equal(typeToString(/** @type {any} */ (s0).type), 'sampler');
    assert.deepEqual(r.module.globals.map(g=>g.name), ['tex0', 's0', 'a', 'b']);
    assert.equal(typeToString(r.module.globals[0].type), 'texture');
});

test('structs, typedefs, techniques and pragmas reach the module', ()=>{
    const r = compile(`
#pragma pack_matrix(row_major)
struct VS_OUT { float4 pos : POSITION; float2 uv : TEXCOORD0; };
typedef float3 vec3;
typedef float4 pair[2];
vec3 f(pair p){ return p[1].xyz; }
technique T { pass P { VertexShader = compile vs_2_0 f(); } }
`);
    assert.deepEqual(r.diagnostics, []);
    const s = r.module.structs.get('VS_OUT');
    assert.deepEqual(s && s.kind === 'struct' && s.members.map(m=>[m.name, typeToString(m.type),
        m.semantic]), [['pos', 'float4', 'POSITION'], ['uv', 'float2', 'TEXCOORD0']]);
    assert.equal(typeToString(/** @type {any} */ (r.module.typedefs.get('vec3'))), 'float3');
    assert.equal(typeToString(/** @type {any} */ (r.module.typedefs.get('pair'))), 'float4[2]');
    assert.equal(r.module.techniques.length, 1);
    assert.equal(r.module.techniques[0].name, 'T');
    assert.deepEqual(r.module.pragmas.map(p=>p.text), ['pack_matrix(row_major)']);
    const f = r.module.findFunction('f');
    assert.equal(typeToString(/** @type {any} */ (f).returnType), 'float3');
    assert.equal(typeToString(/** @type {any} */ (f).params[0].type), 'float4[2]');
});

test('rowMajor is passed through', ()=>{
    assert.equal(compile('float4 f(){ return 0; }', { rowMajor: true }).module.rowMajor, true);
    assert.equal(compile('float4 f(){ return 0; }').module.rowMajor, false);
});

test('array dimensions are constants', ()=>{
    const r = compile(`
static const int N = 4;
static const int M = N * 2 + 1;
float a[N];
float b[M];
float c[N][2];
float d[(int)sqrt(16.0)];
float e[min(N, 3)];
float f(){ float local[N + 1]; return local[N]; }
`);
    assert.deepEqual(r.diagnostics, []);
    const by = Object.fromEntries(r.module.globals.map(g=>[g.name, typeToString(g.type)]));
    assert.equal(by.a, 'float[4]');
    assert.equal(by.b, 'float[9]');
    assert.equal(by.c, 'float[4][2]');
    assert.equal(by.d, 'float[4]');
    assert.equal(by.e, 'float[3]');
});

test('user functions: overloads by conversion rank', ()=>{
    const src = `
float4 pick(float x){ return 1; }
float4 pick(float2 x){ return 2; }
float4 pick(int x){ return 3; }
float4 pick(float3 x, float y){ return 4; }
float4 main(){
    float a = 0; float2 b = 0; int c = 0; float3 d = 0; float4 e = 0;
    return pick(a) + pick(b) + pick(c) + pick(d, a) + pick(e);
}`;
    const r = compile(src, { entry: 'main' });
    assert.deepEqual(r.diagnostics.filter(d=>d.severity === 'error'), []);
    const fn = /** @type {any} */ (r.program.decls.at(-1));
    /** @type {any[]} */
    const calls = [];
    const seen = new Set();
    (function walk(/** @type {any} */ x){
        if (x && typeof x === 'object' && !seen.has(x))
        {
            seen.add(x);
            if (x.kind === 'call')
            {
                calls.push(x);
            }
            for (const key of ['stmts', 'vars', 'init', 'expr', 'value', 'left', 'right',
                'args', 'operand'])
            {
                walk(x[key]);
            }
            if (Array.isArray(x))
            {
                x.forEach(walk);
            }
        }
    })(fn.body);
    assert.deepEqual(calls.map(c=>c.target.fn.overloadKey), [
        'pick(float)', 'pick(float2)', 'pick(int)', 'pick(float3,float)',
        // float4 truncates to float or to float2 at the same rank; float2 drops fewer.
        'pick(float2)']);
    const tie = `${src.split('float4 main')[0]}
        float4 main(){ bool f = false; return pick(f); }`;
    assert.deepEqual(errors(tie), ["X3067: 'pick': ambiguous function call"]);
});

test('user functions: arguments are converted, out and inout stay l-values', ()=>{
    const r = compile(`
void f(float a, out float2 o, inout float3 io){ o = a; io += a; }
void main(){
    int i = 1; float2 p; float3 q = 1;
    f(i, p, q);
}`, { entry: 'main' });
    assert.deepEqual(r.diagnostics, []);
    const call = /** @type {any} */ (r.program.decls.at(-1)).body.stmts.at(-1).expr;
    assert.deepEqual(call.argModes, ['in', 'out', 'inout']);
    assert.equal(call.args[0].kind, 'cast');
    assert.equal(typeToString(call.args[0].type), 'float');
    assert.equal(call.args[1].kind, 'ident');
    assert.equal(call.args[2].kind, 'ident');
    assert.equal(call.target.kind, 'user');
    assert.equal(call.target.fn.name, 'f');
    assert.equal(call.callee.fn, call.target.fn);
    assert.equal(typeToString(call.type), 'void');
});

test('intrinsic calls carry their signature and converted arguments', ()=>{
    const e = exprOf(DECLS, 'lerp(f3, 1, 0.5)');
    assert.equal(e.target.kind, 'intrinsic');
    assert.equal(e.target.name, 'lerp');
    assert.equal(e.callee.intrinsic, 'lerp');
    assert.equal(typeToString(e.target.signature.resultType), 'float3');
    assert.equal(typeToString(e.type), 'float3');
    assert.equal(e.args[0].kind, 'ident');
    assert.equal(e.args[1].kind, 'cast');
    assert.equal(typeToString(e.args[1].type), 'float3');
    assert.equal(typeToString(e.args[2].type), 'float3');
    const t = exprOf(DECLS, 'tex2D(samp, f2)');
    assert.equal(typeToString(t.type), 'float4');
    assert.equal(t.args[0].kind, 'ident');
    assert.equal(typeToString(t.args[0].type), 'sampler2D');
    const m = exprOf(DECLS, 'mul(f4, m44)');
    assert.equal(typeToString(m.type), 'float4');
    const d = exprOf(DECLS, 'dot(f3, f3)');
    assert.equal(typeToString(d.type), 'float');
    assert.equal(typeToString(exprOf(DECLS, 'saturate(i1)').type), 'float');
    assert.equal(typeToString(exprOf(DECLS, 'max(i1, 2)').type), 'int');
    assert.equal(typeToString(exprOf(DECLS, 'max(i1, 2.5)').type), 'float');
});

test('intrinsic out arguments stay l-values', ()=>{
    const e = exprOf(DECLS, 'modf(f3, f3)');
    assert.deepEqual(e.target.signature.outParams, [1]);
    assert.equal(e.args[1].kind, 'ident');
    const s = exprOf(DECLS, 'sincos(f3, f3, st.b)');
    assert.equal(typeToString(s.type), 'void');
    assert.equal(s.args[2].kind, 'member');
    assert.deepEqual(errors(`${DECLS}\nvoid g(){ modf(f1, 3); }`),
        ['X3025: l-value specifies const object']);
    assert.deepEqual(errors(`${DECLS}\nvoid g(){ float x; modf(f1, x.xx); }`),
        ['X3025: invalid l-value']);
});

test('reachable and reachableGlobals follow the call graph in call order', ()=>{
    const r = compile(`
float g1; float g2; float g3; float g4;
float leaf(){ return g3; }
float mid(){ return leaf() + g2; }
float other(){ return g4; }
float main(){ return mid() + other() + leaf() + g1; }
float unused(){ return unused_g; }
float unused_g;
`, { entry: 'main' });
    assert.deepEqual(r.diagnostics, []);
    const main = /** @type {any} */ (r.module.findFunction('main'));
    assert.deepEqual(r.module.reachable(main).map(f=>f.name), ['mid', 'leaf', 'other']);
    assert.deepEqual(r.module.reachable(/** @type {any} */ (r.module.findFunction('leaf'))), []);
    assert.deepEqual(r.module.reachableGlobals(main).map(g=>g.name), ['g1', 'g2', 'g3', 'g4']);
    assert.deepEqual(r.module.reachableGlobals(/** @type {any} */ (r.module.findFunction('mid')))
        .map(g=>g.name), ['g2', 'g3']);
    assert.equal(main.calls.length, 3);
    assert.equal(/** @type {any} */ (r.module.findFunction('unused')).checked, false);
    assert.equal(r.module.findFunction('nothing'), undefined);
    assert.equal(r.module.functions.get('leaf')?.length, 1);
});

test('evaluateConstant on checked expressions', ()=>{
    const r = compile(`
static const int N = 3;
static const float2 v = float2(1, 2);
float u;
void f(){ N * 2; v.y + 1; u + 1; sin(0); N > 2 ? 10 : 20; float3(1, 2, 3) * 2; saturate(1.5); }`);
    assert.deepEqual(r.diagnostics, []);
    const stmts = /** @type {any} */ (r.program.decls.at(-1)).body.stmts;
    const value = (/** @type {number} */ i)=>r.module.evaluateConstant(stmts[i].expr);
    assert.equal(value(0), 6);
    assert.equal(value(1), 3);
    assert.equal(value(2), undefined);
    assert.equal(value(3), 0);
    assert.equal(value(4), 10);
    assert.deepEqual(value(5), [2, 4, 6]);
    assert.equal(value(6), 1);
    assert.equal(r.module.evaluateConstant(null), undefined);
});

test('initialiser lists: flattened by scalar count, converted per position', ()=>{
    const r = compile(`
float4 a = { 1, 2, 3, 4 };
float4 b = { float2(1, 2), 3, 4 };
float2x2 c = { 1, 2, 3, 4 };
float d[3] = { 1, 2, 3 };
float2 e[2] = { { 1, 2 }, { 3, 4 } };
int3 f = { 1.5, 2, 3 };
struct P { int i; float3 v; };
P g = { 1, 2.5, 3, 4 };
float h[] = { 1, 2, 3, 4, 5 };
float2 k[] = { 1, 2, 3, 4 };
void use(){ float4 x = a + b + c._11 + d[0] + e[1].x + f.x + g.v.x + h[1] + k[0].x; }
`);
    assert.deepEqual(r.diagnostics, []);
    const by = Object.fromEntries(r.module.globals.map(g=>[g.name, g]));
    assert.equal(by.a.init.leaves.length, 4);
    assert.equal(typeToString(by.a.init.type), 'float4');
    assert.equal(by.b.init.leaves.length, 3);
    assert.equal(typeToString(by.b.init.leaves[0].type), 'float2');
    assert.equal(typeToString(by.f.init.leaves[0].type), 'int');
    assert.equal(by.f.init.leaves[0].kind, 'cast');
    assert.equal(typeToString(by.g.init.leaves[1].type), 'float');
    assert.equal(by.g.init.leaves[0].kind, 'num');
    assert.equal(typeToString(by.h.type), 'float[5]');
    assert.equal(typeToString(by.k.type), 'float2[2]');
});

test('initialiser list errors', ()=>{
    assert.deepEqual(errors('float4 a = { 1, 2, 3 };'),
        ["X3017: cannot convert initializer list of 3 elements to 'float4' (4 expected)"]);
    assert.deepEqual(errors('float2 a = { 1, 2, 3 };'),
        ["X3017: cannot convert initializer list of 3 elements to 'float2' (2 expected)"]);
    assert.deepEqual(errors('float a[] = { };'),
        ["X3017: cannot convert initializer list to 'float[]'"]);
    assert.deepEqual(errors('float a[];'), []);
    assert.deepEqual(errors('void f(){ float a[]; }'),
        ['X3000: unsized array requires an initializer list']);
    assert.deepEqual(errors('sampler2D s = { 1 };'),
        ["X3017: cannot convert from initializer list to 'sampler2D'"]);
});

test('locals: initialisers are converted; const locals fold', ()=>{
    const r = compile(`
float f(){
    const int n = 3;
    float x = n;
    int y = 2.7;
    float3 z = x;
    bool b = z;
    float arr[n] = { 1, 2, 3 };
    return arr[n - 1];
}`);
    assert.deepEqual(r.diagnostics.map(d=>`${d.code}: ${d.message}`),
        ['X3206: implicit truncation of vector type']);
    const body = /** @type {any} */ (r.program.decls[0]).body.stmts;
    assert.equal(body[0].vars[0].sym.constValue, 3);
    assert.equal(body[1].vars[0].init.kind, 'cast');
    assert.equal(body[2].vars[0].init.kind, 'cast');
    assert.equal(body[3].vars[0].init.kind, 'cast');
    assert.equal(typeToString(body[5].vars[0].sym.type), 'float[3]');
});

// ---- diagnostics -------------------------------------------------------------------------

/**
 * Each case: source, the code, the text, and where it points (line, column).
 *
 * @type {[string, string, string, number, number][]}
 */
const DIAGNOSTICS = [
    ['float f(){\n  return g;\n}', 'X3004', "undeclared identifier 'g'", 2, 10],
    ['float f(){\n  return g(1);\n}', 'X3004', "undeclared identifier 'g'", 2, 10],
    ['float f(){\n  float x = 1;\n  float x = 2;\n  return x;\n}', 'X3003',
        "redefinition of 'x'", 3, 9],
    ['float f(float a, float a){ return a; }', 'X3003', "redefinition of 'a'", 1, 24],
    ['float g(){ return 1; }\nfloat g(){ return 2; }', 'X3003', "redefinition of 'g'", 2, 7],
    ['float a;\nfloat a;', 'X3003', "redefinition of 'a'", 2, 7],
    ['struct S { float a; };\nstruct S { float b; };', 'X3003', "redefinition of 'S'", 2, 1],
    ['struct S { float a; float a; };', 'X3003', "redefinition of 'a'", 1, 27],
    ['float4 f(float3 v){\n  float3x3 m = v;\n  return 0;\n}', 'X3017',
        "cannot convert from 'float3' to 'float3x3'", 2, 16],
    ['float3 f(float4 v){\n  float4 x = v;\n  return x * float3x3(1,2,3,4,5,6,7,8,9);\n}', 'X3020',
        'type mismatch', 3, 12],
    ['struct S { float a; };\nvoid f(){\n  S s; float x = s;\n}', 'X3017',
        "cannot convert from 'S' to 'float'", 3, 18],
    ['struct S { float a; };\nstruct T { float a; };\nvoid f(){\n  S s; T t = s;\n}', 'X3017',
        "cannot convert from 'S' to 'T'", 4, 14],
    ['float f(){\n  float2 v = 1;\n  return v.z;\n}', 'X3018', "invalid subscript 'z'", 3, 11],
    ['float f(){\n  float4 v = 1;\n  return v.xg;\n}', 'X3018', "invalid subscript 'xg'", 3, 11],
    ['float f(){\n  float4 v = 1;\n  return v.xyzwx;\n}', 'X3018', "invalid subscript 'xyzwx'",
        3, 11],
    ['float f(){\n  float4 v = 1;\n  return v.q;\n}', 'X3018', "invalid subscript 'q'", 3, 11],
    ['float f(){\n  float x = 1;\n  return x.y;\n}', 'X3018', "invalid subscript 'y'", 3, 11],
    ['struct S { float a; };\nfloat f(){\n  S s;\n  return s.b;\n}', 'X3018',
        "invalid subscript 'b'", 4, 11],
    ['float f(){\n  float2x2 m = 0;\n  return m._13;\n}', 'X3018', "invalid subscript '_13'",
        3, 11],
    ['float f(){\n  float2x2 m = 0;\n  return m._m22;\n}', 'X3018', "invalid subscript '_m22'",
        3, 11],
    ['float f(){\n  float2x2 m = 0;\n  return m._m00_11;\n}', 'X3018',
        "invalid subscript '_m00_11'", 3, 11],
    ['float f(){\n  float2x2 m = 0;\n  return m._00;\n}', 'X3018', "invalid subscript '_00'",
        3, 11],
    ['float f(){\n  float2x2 m = 0;\n  return m.x;\n}', 'X3018', "invalid subscript 'x'", 3, 11],
    ['float f(){\n  return float4(1, 2, 3);\n}', 'X3014',
        'incorrect number of arguments to numeric-type constructor', 2, 10],
    ['float f(){\n  return float4(1, 2, 3, 4, 5).x;\n}', 'X3014',
        'incorrect number of arguments to numeric-type constructor', 2, 10],
    ['float f(){\n  return float3(float4(1,2,3,4)).x;\n}', 'X3014',
        'incorrect number of arguments to numeric-type constructor', 2, 10],
    ['float f(){\n  return float2().x;\n}', 'X3014',
        'incorrect number of arguments to numeric-type constructor', 2, 10],
    ['struct S { float a; };\nfloat f(){\n  S s;\n  return float2(s, 1).x;\n}', 'X3017',
        "cannot convert from 'S' to 'float2'", 4, 17],
    ['float f(float2 v){\n  return (float3)v;\n}', 'X3017',
        "cannot convert from 'float2' to 'float3'", 2, 10],
    ['void f(){\n  float x = 1;\n  x();\n}', 'X3004', "undeclared identifier 'x'", 3, 3],
    ['float f(){\n  return mul(1, 2, 3);\n}', 'X3013',
        "'mul': no matching 3 parameter intrinsic function", 2, 10],
    ['float f(float3 a){\n  return mul(a, float4x4(1,2,3,4,5,6,7,8,9,0,1,2,3,4,5,6)).x;\n}',
        'X3013', "'mul': no matching 2 parameter intrinsic function", 2, 10],
    ['float f(){\n  return tex2D(1, 2);\n}', 'X3013',
        "'tex2D': no matching 2 parameter intrinsic function", 2, 10],
    ['float f(){\n  return dot(1);\n}', 'X3013',
        "'dot': no matching 1 parameter intrinsic function", 2, 10],
    ['float g(float a, float b){ return a; }\nfloat f(){\n  return g(1);\n}', 'X3013',
        "'g': no matching 1 parameter function", 3, 10],
    ['struct S { float a; };\nfloat g(float a){ return a; }\nfloat f(){\n  S s;\n  return g(s);\n}',
        'X3013', "'g': no matching 1 parameter function", 5, 10],
    ['float g(float a, float2 b){ return a; }\nfloat g(float2 a, float b){ return b; }\n'
        + 'float f(){\n  return g(1, 1);\n}', 'X3067', "'g': ambiguous function call", 4, 10],
    ['float f(){\n  float x = 1;\n  x = noise(x);\n  return x;\n}', 'X3000',
        "'noise': intrinsic function is not supported", 3, 7],
    ['float f(){\n  const float k = 1;\n  k = 2;\n  return k;\n}', 'X3025',
        'l-value specifies const object', 3, 3],
    ['float g;\nvoid f(){\n  g = 2;\n}', 'X3025',
        'global variables are implicitly constant, enable compatibility mode to allow '
        + 'modification', 3, 3],
    ['float f(){\n  1 = 2;\n  return 0;\n}', 'X3025', 'l-value specifies const object', 2, 3],
    ['float f(){\n  float4 v = 0;\n  v.xx = float2(1, 2);\n  return 0;\n}', 'X3025',
        'invalid l-value', 3, 4],
    ['float f(float2x2 m){\n  m._11_11 = float2(1, 2);\n  return 0;\n}', 'X3025',
        'invalid l-value', 2, 4],
    ['float f(uniform float a){\n  a = 2;\n  return a;\n}', 'X3025',
        'l-value specifies const object', 2, 3],
    ['float f(const float a){\n  a++;\n  return a;\n}', 'X3025',
        'l-value specifies const object', 2, 3],
    ['float g(){ return 1; }\nvoid f(){\n  g() = 1;\n}', 'X3025',
        'l-value specifies const object', 3, 3],
    ['float f(sampler2D s){\n  s = s;\n  return 0;\n}', 'X3025',
        'l-value specifies const object', 2, 3],
    ['void g(out float a){ a = 1; }\nvoid f(){\n  g(2);\n}', 'X3025',
        'l-value specifies const object', 3, 5],
    ['void g(out float a){ a = 1; }\nfloat h;\nvoid f(){\n  g(h);\n}', 'X3025',
        'global variables are implicitly constant, enable compatibility mode to allow '
        + 'modification', 4, 5],
    ['float f(float x){\n  if (x > 0)\n  {\n    return 1;\n  }\n}', 'X3507',
        "'f': Not all control paths return a value", 1, 7],
    ['float f(float x){\n  while (x > 0)\n  {\n    return 1;\n  }\n}', 'X3507',
        "'f': Not all control paths return a value", 1, 7],
    ['float f(float x){\n  for (int i = 0; i < 4; i++)\n  {\n    if (x > i)\n    {\n      break;\n'
        + '    }\n  }\n  return 1;\n}\nfloat g(float x){ }', 'X3507',
    "'g': Not all control paths return a value", 11, 7],
    ['void f(){\n  return 1;\n}', 'X3000', "'f': void functions cannot return a value", 2, 3],
    ['float f(){\n  return;\n}', 'X3000', "'f': function must return a value", 2, 3],
    ['struct S { float a; };\nfloat f(){\n  S s;\n  return s;\n}', 'X3017',
        "cannot convert from 'S' to 'float'", 4, 10],
    ['float f(){\n  break;\n  return 1;\n}', 'X3000',
        "'break' statement is not inside a loop or switch", 2, 3],
    ['float f(){\n  continue;\n  return 1;\n}', 'X3000',
        "'continue' statement is not inside a loop", 2, 3],
    ['float f(){\n  switch (1)\n  {\n    default:\n      continue;\n  }\n  return 1;\n}', 'X3000',
        "'continue' statement is not inside a loop", 5, 7],
    ['float f(float3 v){\n  if (v)\n  {\n    return 1;\n  }\n  return 0;\n}', 'X3017',
        "cannot convert from 'float3' to 'bool'", 2, 7],
    ['float f(float3 v){\n  while (v) {}\n  return 0;\n}', 'X3017',
        "cannot convert from 'float3' to 'bool'", 2, 10],
    ['float f(bool3 v){\n  return v ? 1 : 0;\n}', 'X3000',
        'the condition of ?: must be a scalar', 2, 12],
    ['struct S { float a; };\nfloat f(float x){\n  S s;\n  return x ? s : 1;\n}', 'X3020',
        'type mismatch', 4, 12],
    ['float f(float x){\n  return x[0][1];\n}', 'X3121',
        'array, matrix, vector, or indexable object type expected in index expression', 2, 11],
    ['struct S { float a; };\nfloat f(S s){\n  return s[0];\n}', 'X3121',
        'array, matrix, vector, or indexable object type expected in index expression', 3, 11],
    ['float f(float3 v){\n  return v + float3x3(1,2,3,4,5,6,7,8,9);\n}', 'X3020',
        'type mismatch', 2, 12],
    ['struct S { float a; };\nfloat f(S s){\n  return s + 1;\n}', 'X3020', 'type mismatch', 3, 12],
    ['float f(float x){\n  return x & 1;\n}', 'X3082', 'int or unsigned int type required', 2, 12],
    ['float f(float x){\n  return ~x;\n}', 'X3082', 'int or unsigned int type required', 2, 10],
    ['float f(float x){\n  return x << 1;\n}', 'X3082', 'int or unsigned int type required', 2, 12],
    ['float a[0];', 'X3059', 'array dimension must be between 1 and 65536', 1, 9],
    ['float a[70000];', 'X3059', 'array dimension must be between 1 and 65536', 1, 9],
    ['float n;\nfloat a[n];', 'X3058', 'array dimensions must be literal scalar expressions', 2, 9],
    ['void f(){\n  float x;\n  float a[x];\n}', 'X3058',
        'array dimensions must be literal scalar expressions', 3, 11],
    ['float4 f(){\n  return h;\n}\nfloat h;', 'X3004', "undeclared identifier 'h'", 2, 10],
    ['float g(){ return f(); }\nfloat f(){ return 1; }', 'X3004', "undeclared identifier 'f'", 1,
        19],
    ['float f(float x){\n  return f(x - 1);\n}', 'X3500',
        "'f': recursive functions are not allowed", 1, 7],
    ['void v(){ }\nfloat f(){\n  float x = v();\n  return x;\n}', 'X3017',
        "cannot convert from 'void' to 'float'", 3, 13],
    ['float f(){\n  float x = "hello";\n  return x;\n}', 'X3017',
        "cannot convert from 'string' to 'float'", 2, 13],
    ['float4 f(float2 uv){\n  return tex2D(uv, uv);\n}', 'X3013',
        "'tex2D': no matching 2 parameter intrinsic function", 2, 10],
    ['sampler2D s;\nfloat4 f(){\n  return texCUBE(s, float3(0,0,0));\n}', 'X3013',
        "'texCUBE': no matching 2 parameter intrinsic function", 3, 10],
    ['float f(){\n  return x.y(1);\n}', 'X3000', 'methods are not supported', 2, 11],
    ['void f(){\n  void x;\n}', 'X3000', 'illegal variable type', 2, 8],
    ['void x;', 'X3000', 'illegal variable type', 1, 6],
];

test('diagnostics: code, text and position of each error', ()=>{
    /** @type {string[]} */
    const wrong = [];
    for (const [source, code, message, line, col] of DIAGNOSTICS)
    {
        let r;
        try
        {
            r = compile(source);
        }
        catch (e){
            wrong.push(`${source}\n  threw ${e}`);
            continue;
        }
        const d = r.diagnostics.find(x=>x.severity === 'error');
        const got = d ? `${d.code} ${d.message} @${d.pos.line}:${d.pos.col}` : 'no error';
        const want = `${code} ${message} @${line}:${col}`;
        if (got !== want)
        {
            wrong.push(`${source}\n  got  ${got}\n  want ${want}`);
        }
    }
    assert.deepEqual(wrong, []);
});

test('diagnostics: the valid siblings of the failing cases are accepted', ()=>{
    for (const source of [
        'float4 f(float3 v){ float3x3 m = (float3x3)float3x3(1,2,3,4,5,6,7,8,9); return 0; }',
        'float f(float x){ if (x > 0) { return 1; } else { return 2; } }',
        'float f(float x){ while (true) { return 1; } }',
        'float f(float x){ for (;;) { } }',
        'float f(float x){ do { return 1; } while (x > 0); }',
        'float f(float x){ switch (1) { case 1: return 1; default: return 2; } }',
        'void f(){ return; }',
        'float f(float x){ for (int i = 0; i < 4; i++) { if (x > i) { break; } } return 1; }',
        'float f(float2x2 m){ return m._11 + m._m01 + m._11_22.x; }',
        'float f(float4 v){ v.xy = 1; v.zw += 1; return v.x; }',
        'float f(){ float x = 1; { float x = 2; } return x; }',
        'float f(float a, out float b, inout float c){ b = a; c += a; return a; }',
        'float3 f(float3 v, float3x3 m){ return mul(v, m) + mul(m, v); }',
        'float f(float x){ return x ? 1 : 0; }',
    ])
    {
        assert.deepEqual(errors(source), [], source);
    }
});

test('a statement with an error does not hide the next one', ()=>{
    const r = compile(`
float f(){
    float a = nope1;
    float b = 1;
    float c = nope2;
    b.q = 2;
    return a + b + c;
}`);
    assert.deepEqual(r.diagnostics.map(d=>[d.code, d.pos.line]),
        [['X3004', 3], ['X3004', 5], ['X3018', 6]]);
});

test('errors in several functions are all reported', ()=>{
    const r = compile('float f(){ return a; }\nfloat g(){ return b; }');
    assert.deepEqual(r.diagnostics.map(d=>d.message),
        ["undeclared identifier 'a'", "undeclared identifier 'b'"]);
});

test('entry point missing, and unreachable functions are not checked', ()=>{
    assert.deepEqual(errors('float f(){ return 1; }', { entry: 'main' }),
        ["X3501: 'main': entrypoint not found"]);
    const src = 'float bad(){ return nope; }\nfloat main(){ return 1; }';
    assert.deepEqual(errors(src, { entry: 'main' }), []);
    assert.deepEqual(errors(src), ["X3004: undeclared identifier 'nope'"]);
    assert.deepEqual(errors('float bad(){ return nope; }\nfloat main(){ return bad(); }',
        { entry: 'main' }), ["X3004: undeclared identifier 'nope'"]);
});

test('warnings: truncation of vectors and matrices', ()=>{
    assert.deepEqual(warnings('float3 f(float4 v){ return v; }'),
        ['X3206: implicit truncation of vector type']);
    assert.deepEqual(warnings('float f(float4 v){ return v; }'),
        ['X3206: implicit truncation of vector type']);
    assert.deepEqual(warnings('float3 f(float4 v, float3 w){ return v + w; }'),
        ['X3206: implicit truncation of vector type']);
    assert.deepEqual(warnings('float3x3 f(float4x4 m){ return m; }'),
        ['X3205: conversion from larger type to smaller, possible loss of data']);
    assert.deepEqual(warnings('float f(float4 v){ return dot(v, v.xyz); }'),
        ['X3206: implicit truncation of vector type']);
    assert.deepEqual(warnings('float f(float4 v){ return (float)v; }'), []);
    assert.deepEqual(warnings('float3 f(float4 v){ return (float3)v; }'), []);
    assert.deepEqual(warnings('float3 f(float4 v){ return v.xyz; }'), []);
    assert.deepEqual(warnings('float4 f(float v){ return v; }'), []);
    assert.deepEqual(warnings('float f(int v){ return v; }'), []);
    const r = compile('float3 f(float4 v){\n  return v;\n}');
    assert.deepEqual([r.diagnostics[0].severity, r.diagnostics[0].pos.line,
        r.diagnostics[0].pos.col], ['warning', 2, 10]);
});

test('recursion through a prototype is found', ()=>{
    assert.deepEqual(errors('float f(float x);\nfloat f(float x){ return x > 0 ? f(x - 1) : 0; }'),
        ["X3500: 'f': recursive functions are not allowed"]);
});

test('prototypes: a call before the body, and a body that never comes', ()=>{
    assert.deepEqual(errors('float g(float x);\nfloat f(){ return g(1); }\n'
        + 'float g(float x){ return x; }'), []);
    assert.deepEqual(errors('float g(float x);\nfloat f(){ return g(1); }'),
        ["X3000: 'g': function is declared but never defined"]);
    const r = compile('float g(float x);\nfloat f(){ return g(1); }\n'
        + 'float g(float x){ return x; }', { entry: 'f' });
    const call = /** @type {any} */ (r.program.decls[1]).body.stmts[0].value;
    assert.ok(call.target.fn.decl.body);
});

test('uniform entry parameters: explicit, and semantic-less ones of the entry point', ()=>{
    const r = compile(`
struct VS_IN { float4 p : POSITION; };
float4 main(VS_IN i, float4 colour, uniform float k, float3 n : NORMAL, out float4 o : COLOR){
    o = 0;
    return i.p * k + colour;
}
float4 helper(float4 c){ return c; }
`, { entry: 'main' });
    assert.deepEqual(r.diagnostics, []);
    const main = /** @type {any} */ (r.module.findFunction('main'));
    assert.deepEqual(main.params.map((/** @type {any} */ p)=>p.isUniform),
        [false, true, true, false, false]);
    assert.equal(main.params[4].dir, 'out');
    assert.equal(main.semantic, null);
    const helper = /** @type {any} */ (r.module.findFunction('helper'));
    assert.equal(helper.params[0].isUniform, false);
    assert.deepEqual(errors(`float4 main(float4 colour){ colour = 1; return colour; }`,
        { entry: 'main' }), []);
    assert.deepEqual(errors(`float4 main(uniform float4 colour){ colour = 1; return colour; }`,
        { entry: 'main' }), ['X3025: l-value specifies const object']);
});

test('function results keep their semantic', ()=>{
    const r = compile('float4 main() : COLOR0 { return 0; }');
    assert.equal(/** @type {any} */ (r.module.findFunction('main')).semantic, 'COLOR0');
});

test('loops: the scope of the init, nested breaks, and switch', ()=>{
    assert.deepEqual(errors(`float f(){
        float s = 0;
        for (int i = 0; i < 4; i++) { for (int j = 0; j < i; j++) { s += j; if (s > 3) break; } }
        for (int i = 0; i < 2; i++) { s += i; }
        int k = 0;
        while (k < 3) { k++; if (k == 2) continue; s += k; }
        do { k--; } while (k > 0);
        switch (k) { case 0: s = 1; break; case 1: s = 2; break; default: s = 3; }
        return s;
    }`), []);
    assert.deepEqual(errors('float f(){ for (int i = 0; i < 2; i++) { } return i; }'),
        ["X3004: undeclared identifier 'i'"]);
    assert.deepEqual(errors('float f(){ { float inner = 1; } return inner; }'),
        ["X3004: undeclared identifier 'inner'"]);
    assert.deepEqual(errors('float f(float x){ switch (x) { case x: return 1; } return 0; }'),
        ['X3000: case expression must be a constant']);
});

test('global initialisers see only what precedes them', ()=>{
    assert.deepEqual(errors('static float a = b;\nstatic float b = 1;'),
        ["X3004: undeclared identifier 'b'"]);
    assert.deepEqual(errors('static float b = 1;\nstatic float a = b + 1;'), []);
    assert.deepEqual(errors('static float f = g();\nfloat g(){ return 1; }'),
        ["X3004: undeclared identifier 'g'"]);
    assert.deepEqual(errors('float g(){ return 1; }\nstatic float f = g();'), []);
});

test('typedef and struct name resolution', ()=>{
    assert.deepEqual(errors(`
typedef float4 colour;
struct Light { colour c; float3 dir; };
Light make(colour c){ Light l; l.c = c; l.dir = c.xyz; return l; }
float4 use(){ return make(float4(1,2,3,4)).c; }
`), []);
    const e = exprOf('struct Light { float4 c; float3 dir; }; Light l;', 'l.dir.zyx');
    assert.equal(typeToString(e.type), 'float3');
});

test('the intrinsic names can be shadowed by user functions', ()=>{
    const r = compile(`
float4 saturate(float4 x){ return x; }
float4 f(float4 v, float s){ return saturate(v) + saturate(s); }
`);
    assert.deepEqual(r.diagnostics, []);
    const stmt = /** @type {any} */ (r.program.decls[1]).body.stmts[0].value;
    assert.equal(stmt.left.target.kind, 'user');
    assert.equal(stmt.right.operand ? stmt.right.operand.target.kind : stmt.right.target.kind,
        'user');
});
