/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editEvents, keyTap, typeCharacter } from './typing.js';

/** @param {any[]} events */
const brief = events=>events.map(event=>(event.kind === 'key'
    ? `${event.code}${event.down ? '+' : '-'}` : `${event.kind}:${event.text}`));

test('a character is typed on the US layout\'s key for it, with Shift where it needs one', ()=>{
    assert.deepEqual(brief(typeCharacter('w')), ['KeyW+', 'text:w', 'KeyW-']);
    assert.deepEqual(brief(typeCharacter('W')),
        ['ShiftLeft+', 'KeyW+', 'text:W', 'KeyW-', 'ShiftLeft-']);
    assert.deepEqual(brief(typeCharacter('!')),
        ['ShiftLeft+', 'Digit1+', 'text:!', 'Digit1-', 'ShiftLeft-']);
    assert.deepEqual(brief(typeCharacter(' ')), ['Space+', 'text: ', 'Space-']);
    assert.deepEqual(brief(typeCharacter('/')), ['Slash+', 'text:/', 'Slash-']);
});

test('a character no key on the layout types is sent with no key behind it', ()=>{
    assert.deepEqual(typeCharacter('ж'), [{ kind: 'type', text: 'ж' }]);
    assert.deepEqual(typeCharacter('é'), [{ kind: 'type', text: 'é' }]);
    assert.deepEqual(typeCharacter('\u{1f600}'), [{ kind: 'type', text: '\u{1f600}' }]);
});

test('a line break is Enter, whichever character a keyboard made of it', ()=>{
    assert.deepEqual(typeCharacter('\n'), keyTap('Enter'));
    assert.deepEqual(typeCharacter('\r'), keyTap('Enter'));
    assert.deepEqual(brief(keyTap('Enter')), ['Enter+', 'text:\r', 'Enter-']);
});

test('an edit is typed, a line break is Enter, a deletion Backspace or Delete', ()=>{
    assert.deepEqual(brief(editEvents({ inputType: 'insertText', data: 'hI' })),
        ['KeyH+', 'text:h', 'KeyH-', 'ShiftLeft+', 'KeyI+', 'text:I', 'KeyI-', 'ShiftLeft-']);
    assert.deepEqual(editEvents({ inputType: 'insertLineBreak' }), keyTap('Enter'));
    assert.deepEqual(brief(editEvents({ inputType: 'deleteContentBackward' })),
        ['Backspace+', 'text:\b', 'Backspace-']);
    assert.deepEqual(brief(editEvents({ inputType: 'deleteContentForward' })),
        ['Delete+', 'Delete-']);
    assert.deepEqual(editEvents({ inputType: 'formatBold' }), [], 'an edit that types nothing');
    assert.deepEqual(editEvents({ inputType: 'insertText', data: null }), []);
});
