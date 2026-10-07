/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_WINDOW, createWindowDirectory } from './directory.js';

/**
 * A process's windows as its endpoint answers for them.
 *
 * @param {{ hwnd: number, parent?: number, className: string, title: string }[]} windows
 * @param {any[]} [posted]
 */
const process = (windows, posted = [])=>({
    /** @type {import('./directory.js').WindowEndpoint['find']} */
    find(parent, after, className, title){
        let reached = after === 0;
        for (const window of windows)
        {
            if (!reached)
            {
                reached = window.hwnd === after;
                continue;
            }
            if ((window.parent ?? 0) === parent
                && (className === null
                    || window.className.toLowerCase() === className.toLowerCase())
                && (title === null || window.title.toLowerCase() === title.toLowerCase()))
            {
                return window.hwnd;
            }
        }
        return 0;
    },
    /** @param {number} hwnd */
    describe(hwnd){
        const window = windows.find(each=>each.hwnd === hwnd);
        return window ? { threadId: 7, className: window.className, title: window.title } : null;
    },
    /** @param {number} hwnd @param {number} message @param {number} wParam @param {number} lParam */
    post(hwnd, message, wParam, lParam){
        posted.push([hwnd, message, wParam, lParam]);
        return true;
    },
    /** @param {number} hwnd @param {any} request */
    send(hwnd, request){
        posted.push([hwnd, 'sent', request]);
        return windows.some(each=>each.hwnd === hwnd) ? posted.length : null;
    },
    /** @param {number} id */
    answer: id=>(id === posted.length ? { replied: true, result: id } : { replied: false }),
    /** @param {number} id */
    withdraw(id){
        posted.push(['withdrawn', id]);
    },
});

test('a window handle is the run\'s: never one a kernel handle is, never handed out twice', ()=>{
    const directory = createWindowDirectory();
    const handles = [directory.open(0x2000), directory.open(0x2004), directory.open(0x2000)];
    assert.equal(new Set(handles).size, 3);
    for (const hwnd of [...handles, DESKTOP_WINDOW])
    {
        assert.equal(hwnd % 4, 2, `0x${hwnd.toString(16)} is not a multiple of four`);
    }
    assert.ok(!handles.includes(DESKTOP_WINDOW), 'the desktop is no process\'s window');
    assert.deepEqual(handles.map(hwnd=>directory.ownerOf(hwnd)), [0x2000, 0x2004, 0x2000]);
    directory.close(handles[0]);
    assert.equal(directory.ownerOf(handles[0]), null);
    assert.notEqual(directory.open(0x2000), handles[0], 'a closed handle is not reused');
});

test('another process\'s window is found, described and posted to by the process that made it',
    ()=>{
        const directory = createWindowDirectory();
        const mine = directory.open(1);
        const [first, second] = [directory.open(2), directory.open(2)];
        const third = directory.open(3);
        /** @type {any[]} */
        const posted = [];
        directory.attach(1, process([{ hwnd: mine, className: 'Game', title: 'Mine' }]));
        directory.attach(2, process([{ hwnd: first, className: 'Game', title: 'Launcher' },
            { hwnd: second, className: 'Game', title: 'Settings' }], posted));
        directory.attach(3, process([{ hwnd: third, className: 'Game', title: 'Other' }]));

        assert.equal(directory.find(1, 0, 0, 'game', null), first, 'the asker\'s own are not here');
        assert.equal(directory.find(1, 0, first, 'GAME', null), second, 'walked on from one found');
        assert.equal(directory.find(1, 0, second, 'game', null), third, 'into the next process');
        assert.equal(directory.find(1, 0, third, 'game', null), 0);
        assert.equal(directory.find(1, 0, 0, null, 'other'), third);
        assert.equal(directory.find(1, first, 0, null, null), 0, 'children only under a parent');

        assert.deepEqual(directory.describe(second, 1),
            { threadId: 7, className: 'Game', title: 'Settings', processId: 2 });
        assert.equal(directory.describe(mine, 1), null, 'the asker answers for its own');

        assert.equal(directory.post(1, second, 0x8001, 42, -1), true);
        assert.deepEqual(posted, [[second, 0x8001, 42, 0xffffffff]]);
        assert.equal(directory.post(1, mine, 0x8001, 0, 0), false);

        directory.detach(2);
        assert.equal(directory.describe(second, 1), null, 'gone with its process');
        assert.equal(directory.post(1, second, 0x8001, 0, 0), false);
        assert.equal(directory.find(1, 0, 0, 'game', null), third);
    });

test('a message sent to another process\'s window is asked after by number, and a held process'
    + ' takes none', ()=>{
    const directory = createWindowDirectory();
    const theirs = directory.open(2);
    /** @type {any[]} */
    const seen = [];
    directory.attach(2, process([{ hwnd: theirs, className: 'Game', title: 'Game' }], seen));
    const request = { message: 0x4a, wParam: 0, lParam: 0, unicode: false, wait: true,
        carried: { kind: /** @type {const} */ ('copydata'), data: 7, bytes: Uint8Array.of(1, 2) } };
    const sent = directory.send(1, theirs, request);
    assert.deepEqual(sent, { owner: 2, id: 1 });
    assert.deepEqual(seen[0], [theirs, 'sent', request], 'handed over as it was given');
    assert.deepEqual(directory.answer(/** @type {any} */ (sent)), { replied: true, result: 1 });
    directory.withdraw(/** @type {any} */ (sent));
    assert.deepEqual(seen.at(-1), ['withdrawn', 1]);
    assert.equal(directory.send(2, theirs, request), null, 'a process sends to its own itself');

    directory.hold(2, true);
    assert.equal(directory.send(1, theirs, request), null, 'held: nothing it runs would answer');
    assert.equal(directory.post(1, theirs, 0x8001, 0, 0), true, 'a post waits in its queue');
    directory.hold(2, false);
    assert.notEqual(directory.send(1, theirs, request), null);
    directory.detach(2);
    assert.equal(directory.answer({ owner: 2, id: 1 }), null, 'gone with its process');
});

test('a registered name is one number for the run, in any case, kept as first spelled', ()=>{
    const directory = createWindowDirectory();
    const first = directory.register('BottlifyHello');
    assert.equal(first, 0xc000, 'the range Windows keeps for them');
    assert.equal(directory.register('bottlifyhello'), first);
    assert.equal(directory.register('Other'), first + 1);
    assert.equal(directory.registeredName(first), 'BottlifyHello');
    assert.equal(directory.registeredName(0xc100), null);
});
