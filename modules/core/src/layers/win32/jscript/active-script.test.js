/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from '../ole32/objects.js';
import { parseGuid } from '../ole32/guid.js';
import { createFakeGuest } from '../script/guest.fixture.js';
import {
    CLSID_JSCRIPT, IID_IACTIVESCRIPT, IID_IACTIVESCRIPTPARSE32, IID_IOBJECTSAFETY,
    SCRIPTITEM_GLOBALMEMBERS, SCRIPTITEM_ISVISIBLE, SCRIPTSTATE_CLOSED, SCRIPTSTATE_INITIALIZED,
    SCRIPTSTATE_STARTED, SCRIPTTEXT_ISEXPRESSION, SCRIPT_E_REPORTED, registerJScriptClass,
} from './active-script.js';

const S_OK = 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const DISP_E_EXCEPTION = 0x80020009 | 0;
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';
const TEST_CLSID = '{11111111-2222-3333-4444-555555555555}';

/** IActiveScript's slots. */
const SET_SCRIPT_SITE = 3;
const SET_SCRIPT_STATE = 5;
const GET_SCRIPT_STATE = 6;
const CLOSE = 7;
const ADD_NAMED_ITEM = 8;
const GET_SCRIPT_DISPATCH = 10;
/** IActiveScriptParse's. */
const INIT_NEW = 3;
const PARSE_SCRIPT_TEXT = 5;
/** IDispatch's. */
const GET_IDS_OF_NAMES = 5;
const INVOKE = 6;

/**
 * A program hosting the engine: the guest, its site and named items, and
 * the engine created through the class registry as CoCreateInstance would.
 */
function setup(){
    const guest = createFakeGuest();
    const { memory } = guest;
    const registry = createComRegistry();
    /** @type {string[]} */
    const echoed = [];
    /** @type {any} */
    let kept = null;
    const host = guest.dispatchObject({
        Echo: { call: ([text])=>{
            echoed.push(text);
            return 0;
        } },
        Keep: { call: ([value])=>{
            kept = value;
            return 0;
        } },
    });
    const globals = guest.dispatchObject({ Shout: { call: ([text])=>`${text}!` } });
    const made = guest.dispatchObject({ Name: { get: ()=>'made by CoCreateInstance' } });

    registerJScriptClass({
        registry,
        publish: guest.publish,
        com: guest.com,
        system: (library, name, args)=>{
            assert.equal(library, 'ole32.dll');
            if (name === 'CLSIDFromProgID')
            {
                if (memory.wideString(args[0]) !== 'Test.Object')
                {
                    return 0x800401f3 | 0;
                }
                guest.bytes.set(/** @type {Uint8Array} */ (parseGuid(TEST_CLSID)), args[1]);
                return S_OK;
            }
            assert.equal(name, 'CoCreateInstance');
            assert.equal(memory.guid(args[0]), TEST_CLSID);
            assert.equal(memory.guid(args[3]), IID_IDISPATCH);
            made.refs++;
            memory.setU32(args[4], made.pointer);
            return S_OK;
        },
    });

    /** @type {number[]} */
    const states = [];
    /** @type {any[]} */
    const errors = [];
    /** @type {{ refs: number, entered: number, left: number, pointer: number }} */
    const site = { refs: 1, entered: 0, left: 0, pointer: 0 };
    site.pointer = guest.guestObject([
        ()=>0x80004002 | 0,
        ()=>++site.refs,
        ()=>--site.refs,
        ([, out])=>{
            memory.setU32(out, 0x409);
            return S_OK;
        },
        ([, name, , out])=>{
            const item = memory.wideString(name);
            const object = item === 'host' ? host
                : item === 'globals' || item === 'quiet' ? globals : null;
            if (!object)
            {
                return 0x80020006 | 0;
            }
            object.refs++;
            memory.setU32(out, object.pointer);
            return S_OK;
        },
        ()=>0x80004001 | 0,
        ()=>S_OK,
        ([, state])=>{
            states.push(state);
            return S_OK;
        },
        async([, error])=>{
            const excepinfo = guest.allocate(32);
            await guest.callMethod(error, 3, [excepinfo]);
            const position = guest.allocate(12);
            await guest.callMethod(error, 4, [position, position + 4, position + 8]);
            const lineText = guest.allocate(4);
            await guest.callMethod(error, 5, [lineText]);
            errors.push({
                source: guest.readBstr(memory.u32(excepinfo + 4)),
                description: guest.readBstr(memory.u32(excepinfo + 8)),
                scode: memory.i32(excepinfo + 28),
                context: memory.u32(position),
                line: memory.u32(position + 4),
                column: memory.i32(position + 8),
                lineText: guest.readBstr(memory.u32(lineText)),
            });
            return S_OK;
        },
        ()=>{
            site.entered++;
            return S_OK;
        },
        ()=>{
            site.left++;
            return S_OK;
        },
    ]);

    const engineObject = /** @type {any} */ (registry.create(CLSID_JSCRIPT));
    const script = guest.publish(engineObject, IID_IACTIVESCRIPT);

    /** @param {number} pointer @param {string} iid */
    const query = async(pointer, iid)=>{
        const block = guest.allocate(20);
        guest.bytes.set(/** @type {Uint8Array} */ (parseGuid(iid)), block);
        const hr = await guest.callMethod(pointer, 0, [block, block + 16]);
        return hr === S_OK ? memory.u32(block + 16) : 0;
    };
    /** @param {string} text */
    const wide = text=>{
        const at = guest.allocate(text.length * 2 + 2);
        memory.setWide(at, text);
        return at;
    };
    /**
     * @param {number} parse @param {string} code
     * @param {{ flags?: number, line?: number, cookie?: number, excepinfo?: number }} [options]
     */
    const parseText = async(parse, code, options = {})=>{
        const result = guest.allocate(16);
        guest.bytes.fill(0, result, result + 16);
        const hr = await guest.callMethod(parse, PARSE_SCRIPT_TEXT, [wide(code), 0, 0, 0,
            options.cookie ?? 0, options.line ?? 0, options.flags ?? 0, result,
            options.excepinfo ?? 0]);
        return { hr, value: guest.readVariant(result) };
    };
    return {
        guest, memory, registry, engineObject, script, site, host, globals, made, states, errors,
        echoed, kept: ()=>kept, query, wide, parseText,
    };
}

test('a hosted script: initialized, parsed before it starts, run when it does', async()=>{
    const t = setup();
    const { guest, memory, script, site, states } = t;
    const parse = await t.query(script, IID_IACTIVESCRIPTPARSE32);
    assert.notEqual(parse, 0);
    assert.notEqual(await t.query(script, IID_IOBJECTSAFETY), 0);
    assert.equal(await t.query(parse, IID_IUNKNOWN), await t.query(script, IID_IUNKNOWN));

    assert.equal(await guest.callMethod(parse, INIT_NEW, []), S_OK);
    assert.equal(await guest.callMethod(parse, INIT_NEW, []), E_UNEXPECTED);
    assert.equal(await guest.callMethod(script, SET_SCRIPT_SITE, [site.pointer]), S_OK);
    assert.equal(site.refs, 2);
    assert.deepEqual(states, [SCRIPTSTATE_INITIALIZED]);
    assert.equal(await guest.callMethod(script, ADD_NAMED_ITEM, [t.wide('host'),
        SCRIPTITEM_ISVISIBLE]), S_OK);
    assert.equal(await guest.callMethod(script, ADD_NAMED_ITEM, [t.wide('globals'),
        SCRIPTITEM_ISVISIBLE | SCRIPTITEM_GLOBALMEMBERS]), S_OK);

    const queued = await t.parseText(parse,
        'var count = 1;\nhost.Echo("hello " + count);\nfunction twice(n) { return n * 2; }');
    assert.equal(queued.hr, S_OK);
    assert.deepEqual(t.echoed, [], 'nothing runs before the script is started');

    assert.equal(await guest.callMethod(script, SET_SCRIPT_STATE, [SCRIPTSTATE_STARTED]), S_OK);
    assert.deepEqual(t.echoed, ['hello 1']);
    assert.deepEqual(states, [SCRIPTSTATE_INITIALIZED, SCRIPTSTATE_STARTED]);
    assert.ok(site.entered > 0 && site.entered === site.left);
    const stateOut = guest.allocate(4);
    await guest.callMethod(script, GET_SCRIPT_STATE, [stateOut]);
    assert.equal(memory.u32(stateOut), SCRIPTSTATE_STARTED);

    const value = await t.parseText(parse, 'twice(21)', { flags: SCRIPTTEXT_ISEXPRESSION });
    assert.deepEqual(value, { hr: S_OK, value: 42 });
    assert.deepEqual(await t.parseText(parse, 'Shout("hey")', { flags: SCRIPTTEXT_ISEXPRESSION }),
        { hr: S_OK, value: 'hey!' });
    // An item that is not visible lends its members but not its name.
    assert.equal(await guest.callMethod(script, ADD_NAMED_ITEM, [t.wide('quiet'),
        SCRIPTITEM_GLOBALMEMBERS]), S_OK);
    assert.deepEqual(await t.parseText(parse, 'typeof quiet + typeof globals',
        { flags: SCRIPTTEXT_ISEXPRESSION }), { hr: S_OK, value: 'undefinedobject' });
    assert.deepEqual(await t.parseText(parse, 'new ActiveXObject("Test.Object").Name',
        { flags: SCRIPTTEXT_ISEXPRESSION }), { hr: S_OK, value: 'made by CoCreateInstance' });

    // The program reaches the script's own functions and variables.
    const out = guest.allocate(4);
    assert.equal(await guest.callMethod(script, GET_SCRIPT_DISPATCH, [0, out]), S_OK);
    const global = memory.u32(out);
    const names = guest.allocate(8);
    memory.setU32(names, t.wide('twice'));
    assert.equal(await guest.callMethod(global, GET_IDS_OF_NAMES, [0, names, 1, 0x409,
        names + 4]), S_OK);
    const id = memory.i32(names + 4);
    const params = guest.allocate(16);
    const arg = guest.allocate(16);
    await guest.writeVariant(arg, 5);
    memory.setU32(params, arg);
    memory.setU32(params + 4, 0);
    memory.setU32(params + 8, 1);
    memory.setU32(params + 12, 0);
    const result = guest.allocate(16);
    assert.equal(await guest.callMethod(global, INVOKE, [id, 0, 0x409, 1, params, result, 0, 0]),
        S_OK);
    assert.equal(guest.readVariant(result), 10);

    // A script function handed to the program is called through DISPID_VALUE.
    await t.parseText(parse, 'host.Keep(function (a, b) { return a + "-" + b; })');
    const callback = t.kept().pointer;
    const two = guest.allocate(32);
    await guest.writeVariant(two, 'y');
    await guest.writeVariant(two + 16, 'x');
    memory.setU32(params, two);
    memory.setU32(params + 8, 2);
    assert.equal(await guest.callMethod(callback, INVOKE, [0, 0, 0x409, 1, params, result, 0, 0]),
        S_OK);
    assert.equal(guest.readVariant(result), 'x-y');

    // Closing lets every guest object go.
    assert.equal(await guest.callMethod(script, CLOSE, []), S_OK);
    assert.equal(site.refs, 1);
    assert.equal(t.host.refs, 1);
    assert.equal(t.globals.refs, 1);
    assert.equal(t.made.refs, 1);
    assert.deepEqual(states.at(-1), SCRIPTSTATE_CLOSED);
    assert.equal(await guest.callMethod(parse, PARSE_SCRIPT_TEXT, [t.wide('1'), 0, 0, 0, 0, 0,
        0, 0, 0]), E_UNEXPECTED);
});

test('a script error goes to the site\'s OnScriptError, with its position', async()=>{
    const t = setup();
    const { guest, script, site } = t;
    const parse = await t.query(script, IID_IACTIVESCRIPTPARSE32);
    await guest.callMethod(parse, INIT_NEW, []);
    await guest.callMethod(script, SET_SCRIPT_SITE, [site.pointer]);
    await guest.callMethod(script, SET_SCRIPT_STATE, [SCRIPTSTATE_STARTED]);

    const runtime = await t.parseText(parse, 'var a = 1;\n  null.member;', { line: 10,
        cookie: 77 });
    assert.equal(runtime.hr, SCRIPT_E_REPORTED);
    assert.deepEqual(t.errors[0], {
        source: 'Microsoft JScript runtime error', description: 'Object expected',
        scode: 0x800a138f | 0, context: 77, line: 11, column: 2, lineText: '  null.member;',
    });

    const syntax = await t.parseText(parse, 'var = 1;');
    assert.equal(syntax.hr, SCRIPT_E_REPORTED);
    assert.equal(t.errors[1].source, 'Microsoft JScript compilation error');
    assert.equal(t.errors[1].scode, 0x800a03f2 | 0);
    assert.equal(t.errors[1].description, 'Expected identifier');
});

test('with no site, the caller\'s EXCEPINFO is filled', async()=>{
    const t = setup();
    const { guest, memory, script } = t;
    const parse = await t.query(script, IID_IACTIVESCRIPTPARSE32);
    await guest.callMethod(parse, INIT_NEW, []);
    const excepinfo = guest.allocate(32);
    // A statement is not an expression: a compilation error, described.
    const syntax = await t.parseText(parse, 'throw 1', { flags: SCRIPTTEXT_ISEXPRESSION,
        excepinfo });
    assert.equal(syntax.hr, DISP_E_EXCEPTION);
    assert.equal(memory.i32(excepinfo + 28), 0x800a03f2 | 0);
    assert.equal(guest.readBstr(memory.u32(excepinfo + 4)), 'Microsoft JScript compilation error');
    const thrown = await t.parseText(parse, '(function(){ throw new Error(7, "seven") })()',
        { flags: SCRIPTTEXT_ISEXPRESSION, excepinfo });
    assert.equal(thrown.hr, DISP_E_EXCEPTION);
    assert.equal(memory.i32(excepinfo + 28), 7);
    assert.equal(guest.readBstr(memory.u32(excepinfo + 8)), 'seven');
});
