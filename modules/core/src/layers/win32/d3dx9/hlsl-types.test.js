/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from './hlsl-parser.js';
import {
    BOOL, FLOAT, INT, RANK, VOID, arrayOf, baseOf, buildValue, cloneValue, conversionRank,
    convertValue, flatBases, flattenValue, fromTypeRef, isNumeric, matrixOf, sameType,
    samplerOf, scalarCount, scalarOf, shapeOf, structOf, textureOf, toBase, typeToString,
    vectorOf, withBase, zeroValue,
} from './hlsl-types.js';

/** The type of the variable `x` in a one-line program. @param {string} decl */
function typeOfDecl(decl){
    const program = parse(`struct S { float a; float2 b; };\ntypedef float4 vec4;\n${decl}`);
    const v = /** @type {any} */ (program.decls.at(-1));
    const named = new Map([
        ['S', structOf('S', [{ name: 'a', type: FLOAT, semantic: null },
            { name: 'b', type: vectorOf('float', 2), semantic: null }])],
        ['vec4', vectorOf('float', 4)]]);
    return /** @type {any} */ (fromTypeRef(v.type, n=>named.get(n)));
}

test('the element types: half and double are float, uint and dword are int', ()=>{
    assert.equal(typeToString(typeOfDecl('half x;')), 'float');
    assert.equal(typeToString(typeOfDecl('double x;')), 'float');
    assert.equal(typeToString(typeOfDecl('uint x;')), 'int');
    assert.equal(typeToString(typeOfDecl('dword x;')), 'int');
    assert.equal(typeToString(typeOfDecl('bool x;')), 'bool');
    assert.equal(typeToString(typeOfDecl('half3 x;')), 'float3');
    assert.equal(typeToString(typeOfDecl('uint2x2 x;')), 'int2x2');
});

test('type names as fxc prints them', ()=>{
    assert.equal(typeToString(typeOfDecl('float4 x;')), 'float4');
    assert.equal(typeToString(typeOfDecl('float1 x;')), 'float1');
    assert.equal(typeToString(typeOfDecl('float3x3 x;')), 'float3x3');
    assert.equal(typeToString(typeOfDecl('matrix x;')), 'float4x4');
    assert.equal(typeToString(typeOfDecl('vector x;')), 'float4');
    assert.equal(typeToString(typeOfDecl('vector<int, 3> x;')), 'int3');
    assert.equal(typeToString(typeOfDecl('matrix<bool, 2, 3> x;')), 'bool2x3');
    assert.equal(typeToString(typeOfDecl('S x;')), 'S');
    assert.equal(typeToString(typeOfDecl('vec4 x;')), 'float4');
    assert.equal(typeToString(typeOfDecl('sampler x;')), 'sampler');
    assert.equal(typeToString(typeOfDecl('sampler2D x;')), 'sampler2D');
    assert.equal(typeToString(typeOfDecl('samplerCUBE x;')), 'samplerCUBE');
    assert.equal(typeToString(typeOfDecl('sampler3D x;')), 'sampler3D');
    assert.equal(typeToString(typeOfDecl('texture x;')), 'texture');
    assert.equal(typeToString(typeOfDecl('texture2D x;')), 'texture2D');
    assert.equal(typeToString(arrayOf(FLOAT, 4)), 'float[4]');
    assert.equal(typeToString(VOID), 'void');
    assert.equal(typeToString(textureOf('cube')), 'textureCUBE');
});

test('an unknown name does not resolve', ()=>{
    const program = parse('struct T { float a; };\nT x;');
    const v = /** @type {any} */ (program.decls.at(-1));
    assert.equal(fromTypeRef(v.type, ()=>null), null);
});

test('constructors intern, and a vector of one is not a scalar', ()=>{
    assert.equal(vectorOf('float', 3), vectorOf('float', 3));
    assert.equal(matrixOf('int', 2, 3), matrixOf('int', 2, 3));
    assert.equal(scalarOf('float'), FLOAT);
    assert.equal(scalarOf('int'), INT);
    assert.equal(scalarOf('bool'), BOOL);
    assert.equal(sameType(vectorOf('float', 1), FLOAT), false);
    assert.equal(vectorOf('float', 1).kind, 'vector');
    assert.ok(Object.isFrozen(vectorOf('float', 2)));
});

test('sameType compares by structure, structs by name', ()=>{
    assert.ok(sameType(arrayOf(vectorOf('float', 2), 3), arrayOf(vectorOf('float', 2), 3)));
    assert.ok(!sameType(arrayOf(FLOAT, 3), arrayOf(FLOAT, 4)));
    assert.ok(!sameType(arrayOf(FLOAT, 3), arrayOf(INT, 3)));
    assert.ok(!sameType(matrixOf('float', 2, 3), matrixOf('float', 3, 2)));
    assert.ok(!sameType(vectorOf('float', 3), vectorOf('int', 3)));
    assert.ok(sameType(structOf('A', []), structOf('A', [])));
    assert.ok(!sameType(structOf('A', []), structOf('B', [])));
    assert.ok(sameType(samplerOf('2d'), samplerOf('2d')));
    assert.ok(!sameType(samplerOf('2d'), samplerOf('3d')));
    assert.ok(!sameType(samplerOf('2d'), textureOf('2d')));
    assert.ok(sameType(VOID, VOID));
});

test('scalarCount flattens structs and arrays', ()=>{
    const s = typeOfDecl('S x;');
    assert.equal(scalarCount(FLOAT), 1);
    assert.equal(scalarCount(vectorOf('float', 3)), 3);
    assert.equal(scalarCount(matrixOf('float', 3, 4)), 12);
    assert.equal(scalarCount(s), 3);
    assert.equal(scalarCount(arrayOf(s, 2)), 6);
    assert.equal(scalarCount(arrayOf(arrayOf(FLOAT, 2), 3)), 6);
    assert.equal(scalarCount(samplerOf('2d')), 0);
    assert.equal(scalarCount(VOID), 0);
});

test('baseOf, isNumeric, shapeOf', ()=>{
    assert.equal(baseOf(vectorOf('int', 2)), 'int');
    assert.equal(baseOf(matrixOf('bool', 2, 2)), 'bool');
    assert.equal(baseOf(arrayOf(FLOAT, 2)), null);
    assert.equal(baseOf(samplerOf('any')), null);
    assert.ok(isNumeric(FLOAT) && isNumeric(vectorOf('float', 1))
        && isNumeric(matrixOf('int', 1, 1)));
    assert.ok(!isNumeric(arrayOf(FLOAT, 1)) && !isNumeric(VOID));
    assert.deepEqual(shapeOf(FLOAT), { rows: 1, cols: 1 });
    assert.deepEqual(shapeOf(vectorOf('float', 3)), { rows: 1, cols: 3 });
    assert.deepEqual(shapeOf(matrixOf('float', 2, 4)), { rows: 2, cols: 4 });
    assert.equal(shapeOf(VOID), null);
});

test('withBase keeps the shape', ()=>{
    assert.equal(withBase(vectorOf('float', 3), 'int'), vectorOf('int', 3));
    assert.equal(withBase(matrixOf('float', 2, 2), 'bool'), matrixOf('bool', 2, 2));
    assert.equal(withBase(FLOAT, 'int'), INT);
    assert.equal(withBase(VOID, 'int'), VOID);
});

test('conversion ranks order exact < promotion < conversion < truncation < impossible', ()=>{
    const f3 = vectorOf('float', 3);
    const f4 = vectorOf('float', 4);
    const i3 = vectorOf('int', 3);
    assert.equal(conversionRank(f3, f3), RANK.EXACT);
    assert.equal(conversionRank(INT, FLOAT), RANK.PROMOTION);
    assert.equal(conversionRank(BOOL, INT), RANK.PROMOTION);
    assert.equal(conversionRank(FLOAT, INT), RANK.CONVERSION);
    assert.equal(conversionRank(FLOAT, BOOL), RANK.CONVERSION);
    assert.equal(conversionRank(INT, BOOL), RANK.CONVERSION);
    assert.equal(conversionRank(FLOAT, f3), RANK.CONVERSION);
    assert.equal(conversionRank(INT, f3), RANK.CONVERSION);
    assert.equal(conversionRank(FLOAT, i3), RANK.CONVERSION);
    assert.equal(conversionRank(i3, f3), RANK.PROMOTION);
    assert.equal(conversionRank(f3, i3), RANK.CONVERSION);
    assert.equal(conversionRank(f4, f3), RANK.TRUNCATION);
    assert.equal(conversionRank(f3, FLOAT), RANK.TRUNCATION);
    assert.equal(conversionRank(f3, f4), RANK.IMPOSSIBLE);
    assert.equal(conversionRank(vectorOf('float', 1), FLOAT), RANK.PROMOTION);
    assert.equal(conversionRank(FLOAT, vectorOf('float', 1)), RANK.PROMOTION);
    assert.ok(RANK.EXACT < RANK.PROMOTION && RANK.PROMOTION < RANK.CONVERSION
        && RANK.CONVERSION < RANK.TRUNCATION && RANK.TRUNCATION < RANK.IMPOSSIBLE);
});

test('conversion ranks of matrices, structs, arrays and objects', ()=>{
    const m4 = matrixOf('float', 4, 4);
    const m3 = matrixOf('float', 3, 3);
    assert.equal(conversionRank(m4, m3), RANK.TRUNCATION);
    assert.equal(conversionRank(m3, m4), RANK.IMPOSSIBLE);
    assert.equal(conversionRank(matrixOf('float', 2, 4), m3), RANK.IMPOSSIBLE);
    assert.equal(conversionRank(FLOAT, m3), RANK.CONVERSION);
    assert.equal(conversionRank(m3, FLOAT), RANK.TRUNCATION);
    assert.equal(conversionRank(m4, vectorOf('float', 4)), RANK.TRUNCATION);
    assert.equal(conversionRank(vectorOf('float', 4), matrixOf('float', 2, 2)), RANK.CONVERSION);
    assert.equal(conversionRank(vectorOf('float', 3), matrixOf('float', 2, 2)), RANK.IMPOSSIBLE);
    assert.equal(conversionRank(matrixOf('int', 2, 2), matrixOf('float', 2, 2)), RANK.PROMOTION);
    const s = typeOfDecl('S x;');
    assert.equal(conversionRank(s, s), RANK.EXACT);
    assert.equal(conversionRank(s, FLOAT), RANK.IMPOSSIBLE);
    assert.equal(conversionRank(FLOAT, s), RANK.IMPOSSIBLE);
    assert.equal(conversionRank(arrayOf(FLOAT, 2), arrayOf(FLOAT, 3)), RANK.IMPOSSIBLE);
    assert.equal(conversionRank(arrayOf(FLOAT, 2), vectorOf('float', 2)), RANK.IMPOSSIBLE);
    assert.equal(conversionRank(samplerOf('2d'), samplerOf('2d')), RANK.EXACT);
    assert.equal(conversionRank(samplerOf('2d'), FLOAT), RANK.IMPOSSIBLE);
});

test('toBase: bool, int saturating and truncating, float rounded to 32 bits', ()=>{
    assert.equal(toBase(0.5, 'bool'), 1);
    assert.equal(toBase(0, 'bool'), 0);
    assert.equal(toBase(NaN, 'bool'), 1);
    assert.equal(toBase(2.9, 'int'), 2);
    assert.equal(toBase(-2.9, 'int'), -2);
    assert.equal(toBase(NaN, 'int'), 0);
    assert.equal(toBase(1e12, 'int'), 2147483647);
    assert.equal(toBase(-1e12, 'int'), -2147483648);
    assert.equal(toBase(0.1, 'float'), Math.fround(0.1));
    assert.notEqual(toBase(0.1, 'float'), 0.1);
});

test('flatten and build round trip through structs and arrays', ()=>{
    const s = typeOfDecl('S x;');
    const t = arrayOf(s, 2);
    const v = [{ a: 1, b: [2, 3] }, { a: 4, b: [5, 6] }];
    assert.deepEqual(flattenValue(v, t), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(buildValue(t, [1, 2, 3, 4, 5, 6]), v);
    assert.deepEqual(flatBases(t), new Array(6).fill('float'));
    const mixed = structOf('M', [{ name: 'i', type: INT, semantic: null },
        { name: 'f', type: FLOAT, semantic: null }]);
    assert.deepEqual(flatBases(mixed), ['int', 'float']);
    assert.deepEqual(buildValue(mixed, [2.7, 2.7]), { i: 2, f: Math.fround(2.7) });
});

test('matrices flatten row-major', ()=>{
    const m = matrixOf('float', 2, 3);
    assert.deepEqual(flattenValue([[1, 2, 3], [4, 5, 6]], m), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(buildValue(m, [1, 2, 3, 4, 5, 6]), [[1, 2, 3], [4, 5, 6]]);
    assert.deepEqual(zeroValue(m), [[0, 0, 0], [0, 0, 0]]);
    assert.deepEqual(zeroValue(typeOfDecl('S x;')), { a: 0, b: [0, 0] });
});

test('buildValue pads with zero and converts per position', ()=>{
    assert.deepEqual(buildValue(vectorOf('int', 3), [1.9, -1.9]), [1, -1, 0]);
    assert.deepEqual(buildValue(vectorOf('bool', 2), [5, 0]), [1, 0]);
});

test('cloneValue is deep', ()=>{
    const v = { a: [1, 2], b: [[1], [2]] };
    const c = /** @type {any} */ (cloneValue(v));
    c.a[0] = 9;
    c.b[1][0] = 9;
    assert.deepEqual(v, { a: [1, 2], b: [[1], [2]] });
});

test('convertValue: replicate, truncate, reshape, element type', ()=>{
    assert.deepEqual(convertValue(2, FLOAT, vectorOf('float', 3)), [2, 2, 2]);
    assert.deepEqual(convertValue([1, 2, 3, 4], vectorOf('float', 4), vectorOf('float', 2)),
        [1, 2]);
    assert.deepEqual(convertValue([1, 2, 3], vectorOf('float', 3), FLOAT), 1);
    assert.deepEqual(convertValue([1.5, -1.5], vectorOf('float', 2), vectorOf('int', 2)),
        [1, -1]);
    assert.deepEqual(convertValue([0, 2], vectorOf('int', 2), vectorOf('bool', 2)), [0, 1]);
    assert.deepEqual(convertValue([1, 2, 3, 4], vectorOf('float', 4), matrixOf('float', 2, 2)),
        [[1, 2], [3, 4]]);
    assert.deepEqual(convertValue([[1, 2], [3, 4]], matrixOf('float', 2, 2),
        vectorOf('float', 4)), [1, 2, 3, 4]);
    assert.deepEqual(convertValue([[1, 2, 3], [4, 5, 6], [7, 8, 9]], matrixOf('float', 3, 3),
        matrixOf('float', 2, 2)), [[1, 2], [4, 5]]);
    assert.deepEqual(convertValue(1, INT, matrixOf('float', 2, 2)), [[1, 1], [1, 1]]);
    assert.deepEqual(convertValue([1], vectorOf('float', 1), vectorOf('float', 2)), [1, 1]);
    const s = typeOfDecl('S x;');
    const original = { a: 1, b: [2, 3] };
    const copy = /** @type {any} */ (convertValue(original, s, s));
    copy.b[0] = 7;
    assert.deepEqual(original, { a: 1, b: [2, 3] });
});
