/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL_CORE_REMOVED, GL_EXTENSION_COMMANDS, GL_FEATURE_COMMANDS, GL_SIGNATURES }
    from './registry.js';
import { ARGUMENT_WORDS, floatArguments, registryArguments, registryWords } from './exports.js';

test('the registry carries each argument\'s size class as the specification declares it', ()=>{
    // A double and a 64-bit integer are two words on an x86 stack; a pointer-sized
    // integer is a pointer's width.
    assert.equal(GL_SIGNATURES.glClearDepth, 'v:d');
    assert.equal(GL_SIGNATURES.glUniform1d, 'v:id');
    assert.equal(GL_SIGNATURES.glVertexAttribL1ui64ARB, 'v:il');
    assert.equal(GL_SIGNATURES.glMapBufferRange, 'p:ippi');
    assert.equal(GL_SIGNATURES.glFenceSync, 'p:ii');
    assert.equal(GL_SIGNATURES.glUniform4f, 'v:iffff');
    assert.equal(GL_SIGNATURES.glGetString, 'p:i');
});

test('every version and extension names commands the registry declares', ()=>{
    const versions = Object.keys(GL_FEATURE_COMMANDS);
    assert.deepEqual(versions.slice(0, 2), ['GL_VERSION_1_0', 'GL_VERSION_1_1']);
    assert.equal(versions.at(-1), 'GL_VERSION_4_6');
    for (const names of [...Object.values(GL_FEATURE_COMMANDS),
        ...Object.values(GL_EXTENSION_COMMANDS), GL_CORE_REMOVED])
    {
        for (const name of names.split(' '))
        {
            assert.ok(GL_SIGNATURES[name], name);
        }
    }
    assert.ok(GL_FEATURE_COMMANDS.GL_VERSION_4_5.split(' ').includes(
        'glGetNamedFramebufferParameteriv'));
    assert.ok(GL_CORE_REMOVED.split(' ').includes('glBegin'), 'a core profile has no glBegin');
    assert.ok(!GL_CORE_REMOVED.split(' ').includes('glDrawArrays'));
});

test('every export the tables size by hand takes what the registry declares', ()=>{
    // The hand tables came first; a word too many or a float in the wrong
    // place is a stack lost far from the call, so each one the registry knows
    // is held to it.
    let checked = 0;
    for (const [words, names] of Object.entries(ARGUMENT_WORDS))
    {
        for (const name of names)
        {
            if (registryWords(name) === undefined)
            {
                assert.match(name, /^wgl/, `${name} is not in the registry`);
                continue;
            }
            checked++;
            assert.equal(registryWords(name), Number(words), `${name}'s words`);
            /** @type {Record<number, string>} */
            const floats = {};
            let at = 0;
            for (const letter of /** @type {string} */ (registryArguments(name)))
            {
                if (letter === 'f' || letter === 'd')
                {
                    floats[at] = letter === 'f' ? 'f32' : 'f64';
                }
                at += letter === 'd' || letter === 'l' ? 2 : 1;
            }
            assert.deepEqual(floatArguments(name) ?? {}, floats, `${name}'s floats`);
        }
    }
    assert.ok(checked > 700, `${checked} checked`);
});
