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
    IID_IACTIVESCRIPT, IID_IACTIVESCRIPTPARSE32, IID_IOBJECTSAFETY, SCRIPTITEM_GLOBALMEMBERS,
    SCRIPTITEM_ISVISIBLE, SCRIPTSTATE_CLOSED, SCRIPTSTATE_INITIALIZED, SCRIPTSTATE_STARTED,
    SCRIPTTEXT_ISEXPRESSION, SCRIPT_E_REPORTED,
} from '../script/active-script.js';
import { CLSID_VBSCRIPT, registerVBScriptClass } from './active-script.js';

const S_OK = 0;
const DISP_E_EXCEPTION = 0x80020009 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';
const TEST_CLSID = '{11111111-2222-3333-4444-555555555555}';

/** IActiveScript's slots. */
const SET_SCRIPT_SITE = 3;
const SET_SCRIPT_STATE = 5;
const CLOSE = 7;
const ADD_NAMED_ITEM = 8;
const GET_SCRIPT_DISPATCH = 10;
/** IActiveScriptParse's. */
const INIT_NEW = 3;
const PARSE_SCRIPT_TEXT = 5;
/** IDispatch's. */
const GET_IDS_OF_NAMES = 5;
const INVOKE = 6;
/** VARTYPEs. */
const VT_I2 = 2;
const VT_I4 = 3;
const VT_R8 = 5;
const VT_DATE = 7;
const VT_BSTR = 8;
const VT_DISPATCH = 9;
const VT_BOOL = 11;
const VT_VARIANT = 12;
const VT_ARRAY = 0x2000;
const VT_BYREF = 0x4000;

/**
 * A program hosting the engine: the guest, its site and named items, and
 * the engine created through the class registry as CoCreateInstance would.
 */
function setup(){
    const guest = createFakeGuest();
    const { memory } = guest;
    const registry = createComRegistry();
    /** @type {any[]} */
    const kept = [];
    const host = guest.dispatchObject({
        Echo: { call: ([text])=>`echo ${text}` },
        Keep: { call: ([value])=>{
            kept.push(value);
            return 0;
        } },
    }, { items: ['one', 2, true] });
    const globals = guest.dispatchObject({ Shout: { call: ([text])=>`${text}!` } });
    const made = guest.dispatchObject({ Name: { get: ()=>'made by CoCreateInstance' } });
    // A method that answers through its VT_BYREF|VT_VARIANT argument, as an
    // automation server's out parameter does.
    const outParam = guest.guestObject([
        ([self, riid, out])=>{
            const iid = memory.guid(riid);
            const known = iid === IID_IUNKNOWN || iid === IID_IDISPATCH;
            memory.setU32(out, known ? self : 0);
            return known ? S_OK : 0x80004002 | 0;
        },
        ()=>1,
        ()=>1,
        ([, out])=>{
            memory.setU32(out, 0);
            return S_OK;
        },
        ()=>0x8002000b | 0,
        ([, , , , , out])=>{
            memory.setU32(out, 1);
            return S_OK;
        },
        async([, , , , , params, result])=>{
            const variants = memory.u32(params);
            const count = memory.u32(params + 8);
            /** @type {number[]} */
            const types = [];
            for (let i = 0; i < count; i++)
            {
                const at = variants + i * 16;
                types.push(memory.u16(at));
                if ((memory.u16(at) & VT_BYREF) !== 0)
                {
                    const target = memory.u32(at + 8);
                    const was = memory.i32(target + 8);
                    await guest.com.oleaut32('VariantClear', [target]);
                    await guest.writeVariant(target, was * 10);
                }
            }
            if (result !== 0)
            {
                await guest.writeVariant(result, types.join(','));
            }
            return S_OK;
        },
    ]);

    registerVBScriptClass({
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
            made.refs++;
            memory.setU32(args[4], made.pointer);
            return S_OK;
        },
    });

    /** @type {number[]} */
    const states = [];
    /** @type {any[]} */
    const errors = [];
    const site = { refs: 1, pointer: 0 };
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
            const object = item === 'host' ? host : item === 'globals' ? globals
                : item === 'out' ? { pointer: outParam, refs: 0 } : null;
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
        ()=>S_OK,
        ()=>S_OK,
    ]);

    const engineObject = /** @type {any} */ (registry.create(CLSID_VBSCRIPT));
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
        return { hr, vt: memory.u16(result), value: guest.readVariant(result), result };
    };
    /** @param {number} parse @param {string} code */
    const expression = (parse, code)=>parseText(parse, code, { flags: SCRIPTTEXT_ISEXPRESSION });
    /**
     * Invoke on a guest-side IDispatch pointer, arguments first first.
     *
     * @param {number} object @param {string} name @param {number} flags @param {any[]} args
     */
    const invoke = async(object, name, flags, args)=>{
        const names = guest.allocate(8);
        memory.setU32(names, wide(name));
        const found = await guest.callMethod(object, GET_IDS_OF_NAMES, [0, names, 1, 0x409,
            names + 4]);
        const id = name === '' ? 0 : memory.i32(names + 4);
        if (name !== '' && found !== S_OK)
        {
            return { hr: found };
        }
        const params = guest.allocate(16);
        const variants = guest.allocate(16 * Math.max(1, args.length));
        for (let i = 0; i < args.length; i++)
        {
            await guest.writeVariant(variants + (args.length - 1 - i) * 16, args[i]);
        }
        const putId = guest.allocate(4);
        memory.setU32(putId, -3);
        const putting = (flags & 4) !== 0;
        memory.setU32(params, variants);
        memory.setU32(params + 4, putting ? putId : 0);
        memory.setU32(params + 8, args.length);
        memory.setU32(params + 12, putting ? 1 : 0);
        const result = guest.allocate(16);
        guest.bytes.fill(0, result, result + 16);
        const excepinfo = guest.allocate(32);
        const hr = await guest.callMethod(object, INVOKE, [id, 0, 0x409, flags, params, result,
            excepinfo, 0]);
        return { hr, vt: memory.u16(result), value: guest.readVariant(result),
            scode: memory.i32(excepinfo + 28),
            description: hr === DISP_E_EXCEPTION ? guest.readBstr(memory.u32(excepinfo + 8)) : '' };
    };
    return {
        guest, memory, registry, script, site, host, globals, made, states, errors, kept, query,
        wide, parseText, expression, invoke,
    };
}

/** @param {ReturnType<typeof setup>} t */
async function started(t){
    const parse = await t.query(t.script, IID_IACTIVESCRIPTPARSE32);
    await t.guest.callMethod(parse, INIT_NEW, []);
    await t.guest.callMethod(t.script, SET_SCRIPT_SITE, [t.site.pointer]);
    await t.guest.callMethod(t.script, SET_SCRIPT_STATE, [SCRIPTSTATE_STARTED]);
    return parse;
}

test('a hosted VBScript: parsed before it starts, run when it does, its items reached',
    async()=>{
        const t = setup();
        const { guest, script, states } = t;
        const parse = await t.query(script, IID_IACTIVESCRIPTPARSE32);
        assert.notEqual(parse, 0);
        assert.notEqual(await t.query(script, IID_IOBJECTSAFETY), 0);
        assert.equal(await guest.callMethod(parse, INIT_NEW, []), S_OK);
        assert.equal(await guest.callMethod(script, SET_SCRIPT_SITE, [t.site.pointer]), S_OK);
        assert.deepEqual(states, [SCRIPTSTATE_INITIALIZED]);
        assert.equal(await guest.callMethod(script, ADD_NAMED_ITEM, [t.wide('host'),
            SCRIPTITEM_ISVISIBLE]), S_OK);
        assert.equal(await guest.callMethod(script, ADD_NAMED_ITEM, [t.wide('globals'),
            SCRIPTITEM_ISVISIBLE | SCRIPTITEM_GLOBALMEMBERS]), S_OK);

        const queued = await t.parseText(parse,
            'Dim greeting\ngreeting = HOST.Echo("hi")\nFunction Twice(n)\nTwice = n * 2\n'
            + 'End Function');
        assert.equal(queued.hr, S_OK);
        assert.equal(t.host.invokes.length, 0, 'nothing runs before the script is started');
        assert.equal(await guest.callMethod(script, SET_SCRIPT_STATE, [SCRIPTSTATE_STARTED]),
            S_OK);
        assert.equal(t.host.invokes.length, 1);

        assert.deepEqual(await t.expression(parse, 'greeting').then(r=>r.value), 'echo hi');
        assert.deepEqual(await t.expression(parse, 'shout("hey")').then(r=>r.value), 'hey!');
        assert.deepEqual(await t.expression(parse, 'CreateObject("Test.Object").Name')
            .then(r=>r.value), 'made by CoCreateInstance');
        await t.parseText(parse, 'For Each x In host: s = s & TypeName(x) & ",": Next');
        const seen = (await t.expression(parse, 's')).value;
        assert.equal(seen, 'String,Long,Boolean,');

        // The global namespace, case and all.
        const out = guest.allocate(4);
        assert.equal(await guest.callMethod(script, GET_SCRIPT_DISPATCH, [0, out]), S_OK);
        const global = t.memory.u32(out);
        assert.deepEqual(await t.invoke(global, 'TWICE', 1, [21]).then(r=>[r.hr, r.vt, r.value]),
            [S_OK, VT_I4, 42]);
        assert.deepEqual(await t.invoke(global, 'Greeting', 2, []).then(r=>r.value), 'echo hi');
        assert.equal((await t.invoke(global, 'greeting', 4, ['changed'])).hr, S_OK);
        assert.equal((await t.expression(parse, 'greeting')).value, 'changed');

        assert.equal(await guest.callMethod(script, CLOSE, []), S_OK);
        assert.equal(t.site.refs, 1);
        assert.equal(t.host.refs, 1);
        assert.equal(t.globals.refs, 1);
        assert.equal(t.made.refs, 1);
        assert.equal(states.at(-1), SCRIPTSTATE_CLOSED);
        assert.equal(await guest.callMethod(parse, PARSE_SCRIPT_TEXT, [t.wide('1'), 0, 0, 0, 0,
            0, 0, 0, 0]), E_UNEXPECTED);
    });

test('values cross as VBScript\'s VARIANTs, subtypes kept', async()=>{
    const t = setup();
    const parse = await started(t);
    /** @type {[string, number, any][]} */
    const cases = [
        ['1 + 1', VT_I2, 2], ['32767 + 1', VT_I4, 32768], ['CDbl(1)', VT_R8, 1],
        ['1.5', VT_R8, 1.5],
        ['"text"', VT_BSTR, 'text'], ['True', VT_BOOL, true],
        ['#1/2/2003#', VT_DATE, { date: 37623 }],
        ['Nothing', VT_DISPATCH, { pointer: 0 }], ['Empty', 0, undefined], ['Null', 1, null],
        ['CByte(7)', 17, { vt: 17 }], ['CSng(1.5)', 4, { vt: 4 }], ['CCur(2.5)', 6, { vt: 6 }],
    ];
    for (const [text, vt, value] of cases)
    {
        const answer = await t.expression(parse, text);
        assert.deepEqual([answer.hr, answer.vt, answer.value], [S_OK, vt, value], text);
    }
    const array = await t.expression(parse, 'Array(1, "two")');
    assert.equal(array.vt, VT_ARRAY | VT_VARIANT);
    const byte = await t.expression(parse, 'CByte(7)');
    assert.equal(t.memory.u16(byte.result + 8) & 0xff, 7);
    // What the guest hands in keeps its type the other way.
    await t.guest.callMethod(t.script, ADD_NAMED_ITEM, [t.wide('host'), SCRIPTITEM_ISVISIBLE]);
    await t.parseText(parse, 'host.Keep 1: host.Keep 1.0: host.Keep Nothing: host.Keep Null');
    assert.deepEqual(t.host.invokes.map(i=>i.args), [[1], [1], [{ pointer: 0 }], [null]]);
});

test('a variable passed to a guest method is passed by reference and written back',
    async()=>{
        const t = setup();
        const parse = await started(t);
        await t.guest.callMethod(t.script, ADD_NAMED_ITEM, [t.wide('out'), SCRIPTITEM_ISVISIBLE]);
        const answer = await t.expression(parse, 'TypeName(n)');
        assert.equal(answer.value, 'Empty');
        await t.parseText(parse, 'n = 4: a = Array(5)\nr = out.Measure(n, a(0), (n), 3)');
        assert.equal((await t.expression(parse, 'n & "," & a(0)')).value, '40,50');
        // DISPPARAMS holds the arguments last first: the literal 3 and the
        // parenthesised n by value, a(0) and n by reference.
        assert.equal((await t.expression(parse, 'r')).value,
            [VT_I2, VT_I2, VT_BYREF | VT_VARIANT, VT_BYREF | VT_VARIANT].join(','));
    });

test('a script\'s class instance and a GetRef are objects a program can call', async()=>{
    const t = setup();
    const parse = await started(t);
    await t.guest.callMethod(t.script, ADD_NAMED_ITEM, [t.wide('host'), SCRIPTITEM_ISVISIBLE]);
    await t.parseText(parse, `
        Class Greeter
            Public Name
            Private Secret
            Public Default Function Greet(whom)
                Greet = "hello " & whom & " from " & Name
            End Function
            Public Property Get Shout
                Shout = UCase(Name)
            End Property
        End Class
        Function Callback(a, b): Callback = a & "-" & b: End Function
        Set g = New Greeter
        g.Name = "vbs"
        host.Keep g
        host.Keep GetRef("Callback")
    `);
    const [greeter, callback] = t.kept.map(k=>k.pointer);
    assert.deepEqual(await t.invoke(greeter, 'greet', 1, ['you']).then(r=>r.value),
        'hello you from vbs');
    assert.deepEqual(await t.invoke(greeter, '', 3, ['default']).then(r=>r.value),
        'hello default from vbs');
    assert.deepEqual(await t.invoke(greeter, 'SHOUT', 2, []).then(r=>r.value), 'VBS');
    assert.equal((await t.invoke(greeter, 'Name', 4, ['guest'])).hr, S_OK);
    assert.equal((await t.expression(parse, 'g.Name')).value, 'guest');
    assert.equal((await t.invoke(greeter, 'Secret', 2, [])).hr, 0x80020006 | 0);
    assert.deepEqual(await t.invoke(callback, '', 1, ['x', 'y']).then(r=>r.value), 'x-y');
    // A script error inside the program's call comes back as an exception.
    await t.parseText(parse, 'Function Bad(): Bad = 1 / 0: End Function\nhost.Keep GetRef("Bad")');
    const failed = await t.invoke(t.kept[2].pointer, '', 1, []);
    assert.deepEqual([failed.hr, failed.scode, failed.description],
        [DISP_E_EXCEPTION, 0x800a000b | 0, 'Division by zero']);
});

test('script errors go to OnScriptError with VBScript\'s numbers and positions', async()=>{
    const t = setup();
    const parse = await started(t);
    const runtime = await t.parseText(parse, 'a = 1\n  b = a / 0', { line: 10, cookie: 7 });
    assert.equal(runtime.hr, SCRIPT_E_REPORTED);
    assert.deepEqual(t.errors[0], {
        source: 'Microsoft VBScript runtime error', description: 'Division by zero',
        scode: 0x800a000b | 0, context: 7, line: 11, column: 2, lineText: '  b = a / 0',
    });
    const syntax = await t.parseText(parse, 'If x Then');
    assert.equal(syntax.hr, SCRIPT_E_REPORTED);
    assert.equal(t.errors[1].source, 'Microsoft VBScript compilation error');
    assert.equal(t.errors[1].scode, 0x800a03f6 | 0);
    assert.equal(t.errors[1].description, 'Expected \'End\'');
    const raised = await t.parseText(parse, 'Err.Raise vbObjectError + 1, "Mine", "custom"');
    assert.equal(raised.hr, SCRIPT_E_REPORTED);
    assert.deepEqual([t.errors[2].scode, t.errors[2].source, t.errors[2].description],
        [-2147221503, 'Mine', 'custom']);
});

test('with no site, the caller\'s EXCEPINFO is filled', async()=>{
    const t = setup();
    const parse = await t.query(t.script, IID_IACTIVESCRIPTPARSE32);
    await t.guest.callMethod(parse, INIT_NEW, []);
    const excepinfo = t.guest.allocate(32);
    const failed = await t.parseText(parse, 'CInt("x")', { flags: SCRIPTTEXT_ISEXPRESSION,
        excepinfo });
    assert.equal(failed.hr, DISP_E_EXCEPTION);
    assert.equal(t.memory.i32(excepinfo + 28), 0x800a000d | 0);
    assert.equal(t.guest.readBstr(t.memory.u32(excepinfo + 8)), 'Type mismatch');
    assert.equal(t.guest.readBstr(t.memory.u32(excepinfo + 4)), 'Microsoft VBScript runtime error');
});

test('closing the engine terminates the script\'s instances', async()=>{
    const t = setup();
    const parse = await started(t);
    await t.guest.callMethod(t.script, ADD_NAMED_ITEM, [t.wide('host'), SCRIPTITEM_ISVISIBLE]);
    await t.parseText(parse, 'Class T\nPrivate Sub Class_Terminate: host.Echo "bye": End Sub\n'
        + 'End Class\nSet keep = New T');
    const before = t.host.invokes.length;
    await t.guest.callMethod(t.script, CLOSE, []);
    assert.deepEqual(t.host.invokes.slice(before).map(i=>i.args), [['bye']]);
    assert.equal(t.host.refs, 1);
});
