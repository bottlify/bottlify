/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GLSL 1.20 front end against the language specification: what the
 * preprocessor makes of a shader's strings, what compiles, and what is a
 * compile error with which message and line, as an info log reports it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preprocess } from './glsl-preprocess.js';
import { compileShader } from './context-glsl.js';

/** @param {string[]} sources */
const texts = sources=>preprocess(sources).tokens.map(t=>t.text).filter(Boolean).join(' ');

/**
 * @param {string} source @param {'vertex' | 'fragment'} [stage]
 * @returns {{ ok: boolean, log: string }}
 */
const compile = (source, stage = 'fragment')=>compileShader([source], stage);

/** @param {string} body  a fragment shader's main, wrapped */
const fragment = body=>compile(`void main()\n{\n${body}\n}\n`);

test('the preprocessor expands macros, takes conditionals, and keeps each token\'s line', ()=>{
    assert.equal(texts(['#define SQ(x) ((x)*(x))\n#define N 3\nfloat a = SQ(N+1);\n']),
        'float a = ( ( 3 + 1 ) * ( 3 + 1 ) ) ;');
    assert.equal(texts(['#if defined(A) || 2 > 1\nyes\n#else\nno\n#endif\n']), 'yes');
    assert.equal(texts(['#ifdef GL_ES\nprecision mediump float;\n#endif\nint x;\n']), 'int x ;',
        'GL_ES is not defined on the desktop');
    assert.equal(texts(['#define A B\n#define B A\nA\n']), 'A', 'a macro does not expand itself');
    const { tokens } = preprocess(['#version 120\n', 'float a;\n/* two\nlines */ float b;\n']);
    const b = tokens.find(t=>t.text === 'b');
    assert.deepEqual([b?.string, b?.line], [1, 3], 'a token knows its string and its line');
    assert.equal(texts(['int a = __LINE__ + __VERSION__;\n']), 'int a = 1 + 110 ;',
        'the version is 110 without a #version');
});

test('the preprocessor refuses what the language makes an error', ()=>{
    /** @param {string} text */
    const errors = text=>preprocess([text]).diagnostics.filter(d=>d.severity === 'error')
        .map(d=>`${d.line}: ${d.message}`);
    assert.match(errors('#version 130\n')[0], /version 130 is not supported/);
    assert.match(errors('float x;\n#version 120\n')[0], /must occur before anything else/);
    assert.match(errors('#if UNDEFINED\n#endif\n')[0], /undefined identifier/);
    assert.match(errors('#define GL_FOO 1\n')[0], /reserved name/);
    assert.match(errors('#extension GL_ARB_texture_rectangle : require\n')[0],
        /extension is not supported/);
    assert.deepEqual(preprocess(['#extension GL_ARB_draw_buffers : enable\n']).diagnostics
        .map(d=>d.severity), ['warning'], 'an extension merely enabled warns');
    assert.match(errors('#if 1\n')[0], /unterminated conditional/);
    assert.match(errors('#error stop here\n')[0], /#error stop here/);
    assert.match(errors('float a = 1.0e;\n')[0], /invalid number/);
});

test('World of Goo\'s shaders compile, and a log is empty', ()=>{
    const vs = compile(`#version 120
uniform mat4 projection;
uniform mat4 modelview;
attribute vec2 vTex;
attribute vec4 vColor;
attribute vec3 vPosition;
varying vec4 color;
varying vec2 texCoord;
void main()
{
  color = vColor;
  texCoord = vTex;
  gl_Position = projection * modelview * vec4(vPosition, 1.0);
}
`, 'vertex');
    assert.deepEqual(vs, { ...vs, ok: true, log: '' });
    const fs = compile(`#version 120
uniform sampler2D texture;
uniform bool alpha;
uniform bool useTexture;
varying vec4 color;
varying vec2 texCoord;
void main()
{
  vec4 outColor = color;
  if (useTexture) {
    outColor *= texture2D(texture, texCoord);
  }
  if (alpha && outColor.a < (1.0 / 255.0)) {
    discard;
  }
  gl_FragColor = outColor;
}
`);
    assert.equal(fs.log, '');
    assert.equal(fs.ok, true);
});

test('an error is logged as string:line, the first one alone', ()=>{
    const result = compile('void main()\n{\n  gl_FragColor = vec4(undefinedName);\n}\n');
    assert.equal(result.ok, false);
    assert.equal(result.log, 'ERROR: 0:3: \'undefinedName\' : undeclared identifier\n');
    assert.match(compile('void main()\n{\n  float x = ;\n}\n').log,
        /^ERROR: 0:3: ';' : syntax error/);
});

test('an int becomes a float where a float is wanted, and nowhere else', ()=>{
    assert.equal(fragment('float x = 1; vec2 v = vec2(1, 2) * 3; x += 2;').ok, true);
    assert.equal(fragment('vec3 v = ivec3(1, 2, 3);').ok, true, 'an ivec converts to a vec');
    assert.match(fragment('int i = 1.0;').log, /cannot convert from 'float' to 'int'/);
    assert.match(fragment('bool b = 1;').log, /cannot convert from 'int' to 'bool'/);
    assert.match(fragment('mat2 m = mat2(1.0); vec3 v = m * vec3(1.0);').log,
        /wrong operand types/);
    assert.equal(fragment('vec4 v = mat4(1.0) * vec4(1.0); vec3 r = vec3(1.0) * mat3(2.0);').ok,
        true, 'a matrix by a vector, a vector by a matrix');
    assert.match(fragment('float x = 5.0 % 2.0;').log, /reserved operator/);
});

test('overloads are chosen exactly first, then by conversion, and two by conversion are an'
    + ' error', ()=>{
    const both = `float f(float a, int b) { return a; }
float f(int a, float b) { return b; }
void main() { gl_FragColor = vec4(%CALL%); }
`;
    assert.equal(compile(both.replace('%CALL%', 'f(1.0, 2)')).ok, true, 'an exact match');
    assert.match(compile(both.replace('%CALL%', 'f(1, 2)')).log,
        /ambiguous overloaded function call/);
    assert.equal(compile('void main() { gl_FragColor = vec4(max(1, 2.0)); }').ok, true,
        'a built-in by conversion');
    assert.match(compile('void main() { gl_FragColor = vec4(max(true, 2.0)); }').log,
        /no matching overloaded function/);
    assert.equal(compile('float sin(float x) { return x; }\nvoid main() {}').ok, true,
        'version 1.10 lets a function of a built-in\'s name hide it');
    assert.match(compile('#version 120\nfloat sin(float x) { return x; }\nvoid main() {}').log,
        /built-in function cannot be redefined/);
});

test('what cannot be written is refused as an l-value', ()=>{
    assert.match(compile('uniform float u;\nvoid main() { u = 1.0; }').log, /l-value required/);
    assert.match(compile('varying vec4 c;\nvoid main() { c = vec4(1.0); }').log,
        /l-value required/, 'a varying is the fragment stage\'s input');
    assert.equal(compile('varying vec4 c;\nvoid main() { c = vec4(1.0); }', 'vertex').ok, true,
        'and the vertex stage\'s output');
    assert.match(compile('attribute vec4 a;\nvoid main() { a = vec4(1.0); }', 'vertex').log,
        /l-value required/);
    assert.match(fragment('vec4 v; v.xx = vec2(1.0);').log, /repeats a component/);
    assert.match(fragment('const float k = 1.0; k = 2.0;').log, /l-value required/);
    assert.match(fragment('gl_FragCoord = vec4(1.0);').log, /l-value required/);
});

test('constructors take exactly what makes their type', ()=>{
    assert.equal(fragment('vec4 a = vec4(vec2(1.0), 2.0, 3.0); vec3 b = vec3(a);'
        + ' mat3 m = mat3(mat4(1.0)); mat2 d = mat2(2.0); vec2 s = vec2(1.0);').ok, true);
    assert.match(fragment('vec3 v = vec3(1.0, 2.0);').log, /not enough data/);
    assert.match(fragment('vec2 v = vec2(1.0, 2.0, 3.0);').log, /too many arguments/);
    assert.match(fragment('mat2 m = mat2(mat2(1.0), 1.0);').log, /only argument/);
    assert.equal(compile('struct S { float a; vec2 b; };\nvoid main() { S s = S(1, vec2(2.0));'
        + ' gl_FragColor = vec4(s.b, s.a, 1.0); }').ok, true, 'a struct by its members');
    assert.match(compile('struct S { float a; };\nvoid main() { S s = S(1.0, 2.0); }').log,
        /wrong number of arguments/);
});

test('an array is sized by a constant integer expression', ()=>{
    assert.equal(fragment('const int N = 2 * 2; float a[N]; a[N - 1] = 1.0;'
        + ' gl_FragColor = vec4(a.length());').ok, true);
    assert.match(fragment('float n = 2.0; float a[int(n)];').log,
        /constant integer expression/);
    assert.match(fragment('float a[0];').log, /greater than zero/);
    assert.match(fragment('float a[2]; a[2] = 1.0;').log, /index out of range/);
    assert.equal(compile('#version 120\nvoid main() { float a[] = float[](1.0, 2.0, 3.0);'
        + ' gl_FragColor = vec4(a[2]); }').ok, true, '1.20\'s array constructor and unsized'
        + ' declaration');
});

test('the stages have their own built-ins and statements', ()=>{
    assert.match(compile('void main() { discard; }', 'vertex').log, /not supported in vertex/);
    assert.match(compile('void main() { gl_Position = vec4(gl_FragCoord); }', 'vertex').log,
        /not available in the vertex shader/);
    assert.match(compile('uniform sampler2D s;\nvoid main()'
        + ' { gl_FragColor = texture2DLod(s, vec2(0.0), 1.0); }').log,
    /available in the vertex shader only/);
    assert.equal(compile('uniform sampler2D s;\nvoid main()'
        + ' { gl_Position = texture2DLod(s, vec2(0.0), 1.0) + ftransform(); }', 'vertex').ok,
    true);
    assert.match(compile('void main() { gl_Position = vec4(dFdx(1.0)); }', 'vertex').log,
        /fragment shader only/);
    assert.match(compile('attribute vec4 a;\nvoid main() {}').log, /vertex shaders only/);
    assert.match(compile('int main() { return 0; }').log, /void main\(\)/);
    assert.match(fragment('break;').log, /only allowed in loops/);
    assert.match(compile('float gl_mine;\nvoid main() {}').log, /reserved/);
    assert.match(fragment('float switch;').log, /reserved word/);
});

test('a varying, an attribute and a sampler have the types the language allows', ()=>{
    assert.match(compile('varying int i;\nvoid main() {}').log, /a varying must be a float/);
    assert.match(compile('attribute bool b;\nvoid main() {}', 'vertex').log,
        /an attribute must be a float/);
    assert.match(fragment('sampler2D s;').log, /a sampler must be a uniform/);
    assert.equal(compile('#version 120\nuniform float scale = 2.0;\nvoid main()'
        + ' { gl_FragColor = vec4(scale); }').ok, true, 'a uniform initializer in 1.20');
    assert.match(compile('uniform float scale = 2.0;\nvoid main() {}').log, /needs version 120/);
});

test('control flow, functions with out parameters, and structs check', ()=>{
    const source = `#version 120
struct Light { vec3 position; float power; };
uniform Light lights[2];
void accumulate(in Light light, inout vec3 sum, out float weight)
{
    weight = light.power;
    sum += light.position * weight;
}
void main()
{
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 2; i++)
    {
        float w;
        accumulate(lights[i], sum, w);
        if (w > 10.0) break; else continue;
    }
    int k = 0;
    while (k < 3) { k++; }
    do { k--; } while (k > 0);
    gl_FragColor = vec4(sum.zyx, k == 0 ? 1.0 : 0.0);
}
`;
    const result = compile(source);
    assert.equal(result.log, '');
    assert.equal(result.ok, true);
    assert.match(compile('void f(out float x) {}\nvoid main() { f(1.0); }').log,
        /l-value required/, 'an out argument must be writable');
});
