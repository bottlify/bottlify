/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STACK_LIMITS, frustum, identity, multiply, ortho, rotation, scaling, translation }
    from './matrix.js';

/**
 * Pure arithmetic, so there is no context here to tear down; the stack
 * behaviour that needs one is in context.test.js and asserts it there.
 *
 * Every assertion is a number that a transposed implementation gets wrong.
 * Checking that a multiply happened proves nothing at all.
 */

/** @param {ArrayLike<number>} m @param {number[]} v */
function transform(m, v){
    const out = [0, 0, 0, 0];
    for (let row = 0; row < 4; row++)
    {
        let sum = 0;
        for (let column = 0; column < 4; column++)
        {
            sum += m[column * 4 + row] * v[column];
        }
        out[row] = sum;
    }
    return out;
}

/**
 * @param {ArrayLike<number>} actual
 * @param {number[]} expected
 * @param {string} message
 */
function assertClose(actual, expected, message){
    assert.equal(actual.length, expected.length, message);
    for (let i = 0; i < expected.length; i++)
    {
        assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9,
            `${message}: element ${i} is ${actual[i]}, expected ${expected[i]}`);
    }
}

test('translation lives in elements twelve through fourteen', ()=>{
    const m = translation(1, 2, 3);

    assert.equal(m[12], 1);
    assert.equal(m[13], 2);
    assert.equal(m[14], 3);
    assert.equal(m[3], 0, 'and not in the fourth element of the first column');
    assert.equal(m[7], 0);
    assert.equal(m[11], 0);
});

test('a known four by four product comes out element for element', ()=>{
    const a = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const b = Float64Array.from([
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ]);

    assertClose(multiply(a, b), [
        538, 612, 686, 760,
        650, 740, 830, 920,
        762, 868, 974, 1080,
        874, 996, 1118, 1240,
    ], 'a times b');

    // The other order is a different matrix, which is the whole reason the
    // argument order of glMultMatrixf matters.
    assertClose(multiply(b, a), [
        250, 260, 270, 280,
        618, 644, 670, 696,
        986, 1028, 1070, 1112,
        1354, 1412, 1470, 1528,
    ], 'b times a');
});

test('the product applies its right operand to a vector first', ()=>{
    const m = multiply(translation(10, 0, 0), scaling(2, 2, 2));

    assertClose(transform(m, [1, 0, 0, 1]), [12, 0, 0, 1],
        'scaled by two, then moved by ten');
    assertClose(transform(multiply(scaling(2, 2, 2), translation(10, 0, 0)), [1, 0, 0, 1]),
        [22, 0, 0, 1], 'and the other way round the translation is scaled too');
});

test('a rotation about z by ninety degrees turns x into y', ()=>{
    const m = rotation(90, 0, 0, 1);

    assertClose(transform(m, [1, 0, 0, 1]), [0, 1, 0, 1], 'x becomes y');
    assertClose(transform(m, [0, 1, 0, 1]), [-1, 0, 0, 1], 'and y becomes minus x');
});

test('a zero-length rotation axis yields the identity rather than a matrix of NaN', ()=>{
    assertClose(rotation(45, 0, 0, 0), [...identity()], 'degenerate axis');
});

test('an orthographic projection maps its box onto the clip cube', ()=>{
    const m = ortho(0, 640, 480, 0, -1, 1);
    assert.ok(m);

    assertClose(transform(m, [0, 0, 0, 1]), [-1, 1, 0, 1], 'the top left corner');
    assertClose(transform(m, [640, 480, 0, 1]), [1, -1, 0, 1], 'the bottom right one');
});

test('a degenerate orthographic box is refused rather than divided by zero', ()=>{
    assert.equal(ortho(0, 0, 0, 480, -1, 1), null);
    assert.equal(ortho(0, 640, 480, 480, -1, 1), null);
    assert.equal(ortho(0, 640, 480, 0, 1, 1), null);
});

test('a frustum is the one projection with a minus one in element eleven', ()=>{
    const m = frustum(-1, 1, -1, 1, 1, 100);
    assert.ok(m);

    assert.equal(m[11], -1, 'w comes from negated z');
    assert.equal(m[15], 0);
    assertClose([m[10]], [-101 / 99], 'the depth scale');
    assertClose([m[14]], [-200 / 99], 'and the depth offset');
});

test('a frustum with a non-positive near or far plane is refused', ()=>{
    assert.equal(frustum(-1, 1, -1, 1, 0, 100), null);
    assert.equal(frustum(-1, 1, -1, 1, 1, 0), null);
    assert.equal(frustum(-1, 1, -1, 1, -1, 100), null);
});

test('the stacks are the depths the specification requires and no deeper', ()=>{
    assert.equal(STACK_LIMITS.modelview, 32);
    assert.equal(STACK_LIMITS.projection, 2);
    assert.equal(STACK_LIMITS.texture, 2);
});
