/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlslError, formatDiagnostic, tokenize } from './hlsl-lexer.js';
import { parse } from './hlsl-parser.js';

/**
 * An expression as a parenthesised string, so that precedence and
 * associativity can be read off the test.
 *
 * @param {import('./hlsl-parser.js').Expr} e
 * @returns {string}
 */
function show(e){
    switch (e.kind)
    {
        case 'num': return e.text;
        case 'bool': return String(e.value);
        case 'string': return JSON.stringify(e.value);
        case 'ident': return e.name;
        case 'unary': return `(${e.op}${show(e.operand)})`;
        case 'incdec': return e.prefix ? `(${e.op}${show(e.operand)})`
            : `(${show(e.operand)}${e.op})`;
        case 'binary': return `(${show(e.left)} ${e.op} ${show(e.right)})`;
        case 'assign': return `(${show(e.target)} ${e.op} ${show(e.value)})`;
        case 'cond': return `(${show(e.test)} ? ${show(e.then)} : ${show(e.else)})`;
        case 'comma': return `(${e.exprs.map(show).join(', ')})`;
        case 'call': return `${show(e.callee)}(${e.args.map(show).join(', ')})`;
        case 'construct': return `${typeName(e.type)}(${e.args.map(show).join(', ')})`;
        case 'cast': return `<${typeName(e.type)}>${show(e.operand)}`;
        case 'index': return `${show(e.object)}[${show(e.index)}]`;
        case 'member': return `${show(e.object)}.${e.name}`;
        case 'initlist': return `{${e.items.map(show).join(', ')}}`;
        case 'compile': return `compile ${e.target} ${e.callee}(${e.args.map(show).join(', ')})`;
        case 'samplerstate': return `sampler_state{${e.entries.map(x=>
            `${x.name}=${show(x.value)}`).join(';')}}`;
        case 'texref': return `<${e.name}>`;
        default: throw new Error('unknown expression');
    }
}

/** @param {import('./hlsl-parser.js').TypeRef} t */
function typeName(t){
    switch (t.cls)
    {
        case 'scalar': return t.scalar ?? '?';
        case 'vector': return `${t.scalar}${t.cols}`;
        case 'matrix': return `${t.scalar}${t.rows}x${t.cols}`;
        case 'named': return t.name ?? '?';
        default: return t.name ?? t.cls;
    }
}

/** The expression of `float4 x = <source>;` read back as text. @param {string} source */
function expr(source, types = ''){
    const program = parse(`${types}\nvoid f(){ ${source}; }`);
    const body = /** @type {any} */ (program.decls.at(-1)).body;
    const statement = body.stmts[0];
    return show(statement.expr);
}

/** @param {string} source @returns {HlslError} */
function failure(source){
    try
    {
        parse(source);
    }
    catch (e){
        assert.ok(e instanceof HlslError, String(e));
        return e;
    }
    throw new Error('parsed without an error');
}

test('numbers: decimal, hexadecimal, floating point and their suffixes', ()=>{
    const { tokens } = tokenize('1 0x1F 1.5 .5 2. 1e3 1.5e-2 3f 2.0h 7u 1.0F');
    assert.deepEqual(tokens.slice(0, -1).map(t=>[t.type, t.value, t.suffix]), [
        ['int', 1, ''], ['int', 31, ''], ['float', 1.5, ''], ['float', 0.5, ''],
        ['float', 2, ''], ['float', 1000, ''], ['float', 0.015, ''], ['float', 3, 'f'],
        ['float', 2, 'h'], ['int', 7, 'u'], ['float', 1, 'f']]);
});

test('a number glued to letters is malformed, a swizzle on a name is not', ()=>{
    assert.throws(()=>tokenize('12abc'), /malformed number/);
    const { tokens } = tokenize('a.xyz');
    assert.deepEqual(tokens.map(t=>t.text), ['a', '.', 'xyz', '']);
});

test('operators are read longest first', ()=>{
    const { tokens } = tokenize('a<<=b>>=c<=d>=e++f--g&&h||i');
    assert.deepEqual(tokens.filter(t=>t.type === 'punct').map(t=>t.text),
        ['<<=', '>>=', '<=', '>=', '++', '--', '&&', '||']);
});

test('comments are skipped and positions count lines and columns', ()=>{
    const { tokens } = tokenize('a // x\n  /* y\n z */ b\n\tc');
    assert.deepEqual(tokens.slice(0, 3).map(t=>[t.text, t.pos.line, t.pos.col]),
        [['a', 1, 1], ['b', 3, 7], ['c', 4, 2]]);
});

test('#line moves the position and the file; #pragma is kept aside', ()=>{
    const { tokens, pragmas } = tokenize(
        'a\n#pragma pack_matrix(row_major)\n#line 40 "inc.fx"\nb\nc', 'main.fx');
    assert.deepEqual(tokens.slice(0, 3).map(t=>[t.text, t.pos.file, t.pos.line]),
        [['a', 'main.fx', 1], ['b', 'inc.fx', 40], ['c', 'inc.fx', 41]]);
    assert.deepEqual(pragmas.map(p=>p.text), ['pack_matrix(row_major)']);
});

test('strings, with escapes; an unterminated one and a stray character are errors', ()=>{
    assert.equal(tokenize('"a\\"b\\n"').tokens[0].text, 'a"b\n');
    assert.throws(()=>tokenize('"abc'), /unterminated string/);
    assert.throws(()=>tokenize('a @ b'), /unexpected character '@'/);
    assert.throws(()=>tokenize('/* open'), /unterminated comment/);
});

test('diagnostics print as D3DX prints them', ()=>{
    const e = failure('float4 x = ;');
    assert.equal(formatDiagnostic(e),
        'memory(1,12): error X3000: syntax error: unexpected token \';\'');
    assert.equal(e.code, 'X3000');
});

test('precedence and associativity of the binary operators', ()=>{
    assert.equal(expr('a = b + c * d'), '(a = (b + (c * d)))');
    assert.equal(expr('a - b - c'), '((a - b) - c)');
    assert.equal(expr('a = b = c'), '(a = (b = c))');
    assert.equal(expr('a || b && c | d ^ e & f'), '(a || (b && (c | (d ^ (e & f)))))');
    assert.equal(expr('a == b < c'), '(a == (b < c))');
    assert.equal(expr('a << 1 + 2'), '(a << (1 + 2))');
    assert.equal(expr('a * b % c / d'), '(((a * b) % c) / d)');
    assert.equal(expr('a += b -= c'), '(a += (b -= c))');
});

test('the ternary operator nests to the right and binds looser than ||', ()=>{
    assert.equal(expr('a || b ? c : d ? e : f'), '((a || b) ? c : (d ? e : f))');
    assert.equal(expr('x = a ? b : c'), '(x = (a ? b : c))');
    assert.equal(expr('a ? b = 1 : c'), '(a ? (b = 1) : c)');
});

test('unary, increments and the postfix chain', ()=>{
    assert.equal(expr('-a * b'), '((-a) * b)');
    assert.equal(expr('!a && ~b'), '((!a) && (~b))');
    assert.equal(expr('++i + j--'), '((++i) + (j--))');
    assert.equal(expr('m[i].xyz[2]'), 'm[i].xyz[2]');
    assert.equal(expr('-a.x'), '(-a.x)');
    assert.equal(expr('a[i][j]++'), '(a[i][j]++)');
});

test('calls, constructors and the comma operator', ()=>{
    assert.equal(expr('f(a, b + 1, g(c))'), 'f(a, (b + 1), g(c))');
    assert.equal(expr('float4(a.xyz, 1)'), 'float4(a.xyz, 1)');
    assert.equal(expr('float3x3(1,0,0, 0,1,0, 0,0,1)'), 'float3x3(1, 0, 0, 0, 1, 0, 0, 0, 1)');
    assert.equal(expr('x = vector<half, 3>(1, 2, 3)'), '(x = half3(1, 2, 3))');
    assert.equal(expr('x = matrix<int, 2, 3>(a)'), '(x = int2x3(a))');
    assert.equal(expr('(a, b)'), '(a, b)');
    assert.equal(expr('tex.Sample(s, uv)'), 'tex.Sample(s, uv)');
});

test('a cast is a parenthesised type; a parenthesised name is not', ()=>{
    assert.equal(expr('(float3)a + b'), '(<float3>a + b)');
    assert.equal(expr('(float4x4)m'), '<float4x4>m');
    assert.equal(expr('(int)f(x)'), '<int>f(x)');
    assert.equal(expr('(a) - b'), '(a - b)');
    assert.equal(expr('(float3(1,2,3)).x'), 'float3(1, 2, 3).x');
    assert.equal(expr('(half)(a + b)'), '<half>(a + b)');
    assert.equal(expr('(S)a', 'struct S { float x; };'), '<S>a');
    assert.equal(expr('(T) - 1', 'typedef float4 T;'), '<T>(-1)');
});

test('literals: the type a suffix gives, booleans, strings', ()=>{
    const program = parse('void f(){ a = 1; b = 1.0; c = 1.0h; d = 2u; e = true; g = "s"; }');
    const stmts = /** @type {any} */ (program.decls[0]).body.stmts;
    assert.deepEqual(stmts.slice(0, 4).map((/** @type {any} */ s)=>s.expr.value.ntype),
        ['int', 'float', 'half', 'uint']);
    assert.equal(stmts[4].expr.value.value, true);
    assert.equal(stmts[5].expr.value.value, 's');
});

test('built-in type names: scalars, vectors, matrices, objects and the generic forms', ()=>{
    const names = [
        ['float', 'scalar', 'float', 1, 1], ['half2', 'vector', 'half', 1, 2],
        ['int3', 'vector', 'int', 1, 3], ['bool4', 'vector', 'bool', 1, 4],
        ['float3x4', 'matrix', 'float', 3, 4], ['half4x4', 'matrix', 'half', 4, 4],
        ['float1', 'vector', 'float', 1, 1], ['matrix', 'matrix', 'float', 4, 4],
        ['vector', 'vector', 'float', 1, 4], ['uint', 'scalar', 'uint', 1, 1],
        ['dword', 'scalar', 'uint', 1, 1], ['double2', 'vector', 'double', 1, 2],
    ];
    for (const [name, cls, scalar, rows, cols] of names)
    {
        const program = parse(`${name} v;`);
        const type = /** @type {any} */ (program.decls[0]).type;
        assert.deepEqual([type.cls, type.scalar, type.rows, type.cols], [cls, scalar, rows, cols],
            String(name));
    }
    const objects = parse('sampler a; sampler2D b; samplerCUBE c; sampler3D d; texture e;'
        + ' texture2D f; string g;').decls.map(d=>/** @type {any} */ (d).type);
    assert.deepEqual(objects.map(t=>[t.cls, t.dim]), [['sampler', 'any'], ['sampler', '2d'],
        ['sampler', 'cube'], ['sampler', '3d'], ['texture', 'any'], ['texture', '2d'],
        ['string', undefined]]);
    assert.throws(()=>parse('float5 x;'), HlslError);
    assert.throws(()=>parse('vector<float, 7> x;'), /dimensions/);
});

test('global variables: modifiers, arrays, semantics, registers, annotations, initialisers', ()=>{
    const program = parse(`
        uniform float4x4 WorldViewProj : register(c0);
        static const float PI = 3.14159, TWO_PI = 2 * PI;
        float4 Lights[4] : register(vs, c8);
        float3x3 Basis[2][3];
        float4 Packed : packoffset(c1.y);
        texture Diffuse < string name = "diffuse.dds"; int Width = 64; >;
        float Blend < float min = 0; > = 0.5;
        float Taps[3] = { 0.25, 0.5, 0.25 };
        float4x4 Zero = { {0,0,0,0}, {0,0,0,0}, {0,0,0,0}, {0,0,0,0} };
        float Flexible[];
    `);
    const v = /** @type {import('./hlsl-parser.js').Variable[]} */ (program.decls);
    assert.deepEqual(v.map(x=>x.name), ['WorldViewProj', 'PI', 'TWO_PI', 'Lights', 'Basis',
        'Packed', 'Diffuse', 'Blend', 'Taps', 'Zero', 'Flexible']);
    assert.deepEqual(v[0].mods, ['uniform']);
    assert.deepEqual(v[0].register, { profile: null, name: 'c0' });
    assert.deepEqual(v[1].mods, ['static', 'const']);
    assert.equal(show(/** @type {any} */ (v[2].init)), '(2 * PI)');
    assert.deepEqual(v[3].register, { profile: 'vs', name: 'c8' });
    assert.equal(v[3].dims.map(show).join(), '4');
    assert.equal(v[4].dims.map(show).join(), '2,3');
    assert.deepEqual(v[5].packoffset, { register: 'c1', component: 'y' });
    assert.deepEqual(v[6].annotations.map(a=>[a.name, show(/** @type {any} */ (a.value))]),
        [['name', '"diffuse.dds"'], ['Width', '64']]);
    assert.equal(v[7].annotations[0].name, 'min');
    assert.equal(show(/** @type {any} */ (v[8].init)), '{0.25, 0.5, 0.25}');
    assert.equal(show(/** @type {any} */ (v[9].init)), '{{0, 0, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}, {0, 0, 0, 0}}');
    assert.equal(v[10].dims[0].kind === 'num' && v[10].dims[0].value, -1);
});

test('structures with semantics, interpolation modifiers and an instance', ()=>{
    const program = parse(`
        struct VS_OUT
        {
            float4 pos : POSITION;
            float2 uv, uv2 : TEXCOORD0;
            nointerpolation float4 flat : COLOR1;
            float fog : FOG;
        };
        struct Pair { float a; float b; } pair;
        VS_OUT v;
    `);
    const struct = /** @type {import('./hlsl-parser.js').StructDecl} */ (program.decls[0]);
    assert.deepEqual(struct.members.map(m=>[m.name, m.semantic]), [['pos', 'POSITION'],
        ['uv', null], ['uv2', 'TEXCOORD0'], ['flat', 'COLOR1'], ['fog', 'FOG']]);
    assert.deepEqual(struct.members[3].mods, ['nointerpolation']);
    assert.deepEqual(program.decls.map(d=>d.kind), ['struct', 'struct', 'var', 'var']);
    assert.equal(/** @type {any} */ (program.decls[3]).type.name, 'VS_OUT');
});

test('typedef introduces a type name, and cbuffer a scope of globals', ()=>{
    const program = parse(`
        typedef float3 Vec;
        typedef float4 Quad[2];
        Vec dir;
        cbuffer Frame : register(b0) { float4 a; float4x4 m; };
    `);
    assert.deepEqual(program.decls.map(d=>d.kind), ['typedef', 'typedef', 'var', 'cbuffer']);
    const frame = /** @type {import('./hlsl-parser.js').CBufferDecl} */ (program.decls[3]);
    assert.deepEqual(frame.members.map(m=>m.name), ['a', 'm']);
    assert.equal(frame.register?.name, 'b0');
});

test('functions: parameters, qualifiers, semantics, prototypes, attributes', ()=>{
    const program = parse(`
        float4 Shade(in float3 n, out float4 c : COLOR0, inout float l = 1,
            uniform float k) : COLOR;
        void Empty(void) {}
        float4 main(float4 pos : POSITION, float2 uv : TEXCOORD0) : COLOR0
        {
            return pos;
        }
    `);
    const [proto, empty, main] = /** @type {import('./hlsl-parser.js').FunctionDecl[]} */ (
        program.decls);
    assert.equal(proto.body, null);
    assert.equal(proto.semantic, 'COLOR');
    assert.deepEqual(proto.params.map(p=>[p.name, p.mods.join(), p.semantic]), [['n', 'in', null],
        ['c', 'out', 'COLOR0'], ['l', 'inout', null], ['k', 'uniform', null]]);
    assert.equal(show(/** @type {any} */ (proto.params[2].init)), '1');
    assert.equal(empty.params.length, 0);
    assert.equal(main.semantic, 'COLOR0');
    assert.deepEqual(main.params.map(p=>p.semantic), ['POSITION', 'TEXCOORD0']);
    assert.equal(main.body?.kind, 'block');
});

test('statements: if, for, while, do, switch, jumps, declarations, attributes', ()=>{
    const program = parse(`
        float f(float x)
        {
            const float k = 2, j = 3;
            float4 v[2], w;
            if (x > 0) x = 1; else if (x < 0) { x = -1; } else x = 0;
            [unroll] for (int i = 0; i < 4; i++) { x += i; if (x > 9) break; else continue; }
            [loop] for (;;) { break; }
            [unroll(3)] while (x < 10) x *= 2;
            do { x--; } while (x > 0);
            [branch] if (x) discard;
            switch (x) { case 1: x = 2; break; default: x = 3; }
            for (x = 0; x < 3; x++);
            ;
            return x;
        }
    `);
    const stmts = /** @type {any[]} */ (/** @type {any} */ (program.decls[0]).body.stmts);
    assert.deepEqual(stmts.map(s=>s.kind), ['decl', 'decl', 'if', 'for', 'for', 'while', 'do',
        'if', 'switch', 'for', 'empty', 'return']);
    assert.deepEqual(stmts[0].vars.map((/** @type {any} */ v)=>v.name), ['k', 'j']);
    assert.deepEqual(stmts[0].vars[0].mods, ['const']);
    assert.equal(stmts[1].vars[0].dims.length, 1);
    assert.equal(stmts[2].else.kind, 'if');
    assert.equal(stmts[3].attributes[0].name, 'unroll');
    assert.equal(stmts[3].init.kind, 'decl');
    assert.equal(show(stmts[3].test), '(i < 4)');
    assert.equal(show(stmts[3].step), '(i++)');
    assert.equal(stmts[4].test, null);
    assert.equal(stmts[4].step, null);
    assert.equal(stmts[5].attributes[0].args.length, 1);
    assert.equal(stmts[7].attributes[0].name, 'branch');
    assert.equal(stmts[7].then.kind, 'discard');
    assert.deepEqual(stmts[8].cases.map((/** @type {any} */ c)=>c.value && c.value.value), [1, null]);
    assert.equal(stmts[9].init.kind, 'expr');
});

test('a user type starts a declaration when a name follows it, a call when a bracket', ()=>{
    const program = parse(`
        struct S { float x; };
        void f()
        {
            S a;
            S b = (S)0;
            float c = S(1).x;
        }
    `);
    const stmts = /** @type {any[]} */ (/** @type {any} */ (program.decls[1]).body.stmts);
    assert.deepEqual(stmts.map(s=>s.kind), ['decl', 'decl', 'decl']);
    assert.equal(show(stmts[2].vars[0].init), 'S(1).x');
});

test('soft modifiers are names unless a type follows', ()=>{
    const program = parse(`
        void f()
        {
            float linear = 1;
            linear = linear * 2;
            centroid float4 v;
            sample = 3;
        }
    `);
    const stmts = /** @type {any[]} */ (/** @type {any} */ (program.decls[0]).body.stmts);
    assert.deepEqual(stmts.map(s=>s.kind), ['decl', 'expr', 'decl', 'expr']);
    assert.deepEqual(stmts[2].vars[0].mods, ['centroid']);
});

test('effects: sampler_state, techniques, passes, compile', ()=>{
    const program = parse(`
        texture Tex;
        sampler2D Smp = sampler_state { Texture = <Tex>; MinFilter = LINEAR; AddressU = Clamp; };
        technique T < string note = "x"; >
        {
            pass P0
            {
                AlphaBlendEnable = true;
                SrcBlend = SrcAlpha;
                Sampler[0] = (Smp);
                VertexShader = compile vs_2_0 VS(1.0);
                PixelShader = compile ps_2_0 PS();
                ZEnable = 1;
            }
            pass { }
        }
    `);
    const sampler = /** @type {import('./hlsl-parser.js').Variable} */ (program.decls[1]);
    assert.equal(show(/** @type {any} */ (sampler.init)),
        'sampler_state{Texture=<Tex>;MinFilter=LINEAR;AddressU=Clamp}');
    const technique = /** @type {import('./hlsl-parser.js').TechniqueDecl} */ (program.decls[2]);
    assert.equal(technique.name, 'T');
    assert.equal(technique.annotations[0].name, 'note');
    assert.equal(technique.passes.length, 2);
    assert.equal(technique.passes[1].name, null);
    const states = technique.passes[0].states;
    assert.deepEqual(states.map(s=>s.name), ['AlphaBlendEnable', 'SrcBlend', 'Sampler',
        'VertexShader', 'PixelShader', 'ZEnable']);
    assert.equal(show(/** @type {any} */ (states[2].index)), '0');
    assert.equal(show(states[3].value), 'compile vs_2_0 VS(1.0)');
});

test('#pragma and stray semicolons at the top level are accepted', ()=>{
    const program = parse('#pragma pack_matrix(row_major)\n;;\nfloat x;;');
    assert.equal(program.decls.length, 1);
    assert.equal(program.pragmas[0].text, 'pack_matrix(row_major)');
});

test('syntax errors name the token and where it is', ()=>{
    assert.match(formatDiagnostic(failure('float4 f(){ return 1 }')),
        /^memory\(1,22\): error X3000: syntax error: unexpected token '}'$/);
    assert.match(failure('float4 f(){ x = ; }').message, /unexpected token ';'/);
    assert.match(failure('float4 f(){ if x }').message, /unexpected token 'x'/);
    assert.match(failure('float f(').message, /unexpected end of file/);
    assert.match(failure('float4 f(){ return 1;').message, /unexpected end of file/);
    assert.match(failure('struct A : B { };').message, /unexpected token ':'/);
    assert.match(failure('float x = 1 +;').message, /unexpected token ';'/);
    assert.match(failure('}').message, /unexpected token '}'/);
    const second = failure('float x;\nfloat y\nfloat z;');
    assert.deepEqual([second.pos.line, second.pos.col], [3, 1]);
});
