/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DISP_E_EXCEPTION, DISP_E_UNKNOWNNAME, ExternalError, hostObject,
} from '../script/external.js';
import { ScriptError } from '../script/engine.js';
import { dateValue, variantArray } from '../script/values.js';
import { createJScriptEngine } from '../jscript/engine.js';
import { VBScriptError, createVBScriptEngine } from './engine.js';

/** A value a moment later, as a guest object answers. @template T @param {T} value */
const later = value=>new Promise(done=>setImmediate(()=>done(value)));

/**
 * An installer's Session as a custom action sees it: a property store
 * reached through a parameterised property, a log of messages, and a
 * collection.
 *
 * @param {{ async?: boolean }} [options]
 */
function session(options = {}){
    /** @type {Map<string, string>} */
    const properties = new Map([['ProductName', 'Example']]);
    /** @type {unknown[][]} */
    const messages = [];
    /** @template T @param {T} value */
    const answer = value=>(options.async ? later(value) : value);
    const object = hostObject({
        typeName: 'Session',
        members: {
            Property: {
                get: ([name])=>answer(properties.get(String(name)) ?? ''),
                put: (value, [name])=>{
                    properties.set(String(name), String(value));
                    return options.async ? later(undefined) : undefined;
                },
            },
            Message: {
                call: args=>{
                    messages.push(args);
                    return answer(1);
                },
            },
            Fail: {
                call: ()=>{
                    throw new ExternalError(0x80070005 | 0);
                },
            },
            Refuse: {
                call: ()=>{
                    throw new ExternalError(0x800a0bb8 | 0, 'the installer said no', 'Msi');
                },
            },
            // A method that answers through its argument, as GetFileVersion's
            // kin answer through a VT_BYREF.
            Measure: {
                call: args=>{
                    args[0] = `${args[0]}!`;
                    args[1] = 42;
                    return answer(true);
                },
            },
            Today: { get: ()=>dateValue(37623) },
            List: { get: ()=>variantArray(['a', 'b']) },
        },
        value: { get: ()=>'[Session]' },
        items: ()=>(options.async ? later(['first', 'second']) : ['first', 'second']),
    });
    return { object, properties, messages };
}

test('an installer\'s Session: properties read and assigned, methods called', async()=>{
    for (const async of [false, true])
    {
        const { object, properties, messages } = session({ async });
        const engine = createVBScriptEngine();
        engine.addNamedItem('Session', object);
        await engine.run(`
            Function CustomAction()
                Dim name
                name = Session.Property("ProductName")
                Session.Property("RESULT") = name & " ok"
                Session.Property("COUNT") = 1 + 1
                Session.Message &H01000000, "logged"
                CustomAction = 1
            End Function
            Dim seen
            For Each item In Session
                seen = seen & item & ";"
            Next
            Dim viaDefault: viaDefault = Session
            Dim t: t = TypeName(Session) & TypeName(Session.Today) & UBound(Session.List)
        `);
        assert.equal(await engine.call('CustomAction'), 1, `async ${async}`);
        assert.equal(properties.get('RESULT'), 'Example ok');
        assert.equal(properties.get('COUNT'), '2');
        assert.deepEqual(messages, [[0x01000000, 'logged']]);
        assert.equal(engine.getGlobal('seen'), 'first;second;');
        assert.equal(engine.getGlobal('viaDefault'), '[Session]');
        assert.equal(engine.getGlobal('t'), 'SessionDate1');
    }
});

test('a variable passed to an external method gets back what the method stored', async()=>{
    for (const async of [false, true])
    {
        const engine = createVBScriptEngine();
        engine.addNamedItem('Session', session({ async }).object);
        await engine.run(`
            Dim text, size, a(1), ok
            text = "file": a(0) = 0
            ok = Session.Measure(text, a(0))
            Dim kept: kept = "same"
            ok = ok And Session.Measure((kept), 5)
            out = text & "|" & a(0) & "|" & TypeName(a(0)) & "|" & kept & "|" & ok
        `);
        assert.equal(engine.getGlobal('out'), 'file!|42|Long|same|True', `async ${async}`);
    }
});

test('an external object\'s failure is VBScript\'s error, catchable and reported', async()=>{
    const engine = createVBScriptEngine();
    engine.addNamedItem('Session', session().object);
    await engine.run(`
        On Error Resume Next
        Session.Fail
        out = Err.Number & ":" & Err.Description
        Err.Clear
        Session.Refuse
        out = out & "|" & Err.Number & ":" & Err.Description & ":" & Err.Source
        Err.Clear
        x = Session.Nope
        out = out & "|" & Err.Number
    `);
    assert.equal(engine.getGlobal('out'),
        '70:Permission denied|3000:the installer said no:Msi|438');
    await assert.rejects(engine.run('Session.Refuse'), e=>e instanceof VBScriptError
        && e.number === 3000 && e.scode === (0x800a0bb8 | 0) && e.source === 'Msi');
});

test('CreateObject and GetObject go to the embedder', async()=>{
    /** @type {unknown[]} */
    const asked = [];
    const engine = createVBScriptEngine({
        createObject: (progId, location)=>{
            asked.push([progId, location]);
            if (progId === 'Missing.Class')
            {
                throw new ExternalError(0x80040154 | 0);
            }
            return later(hostObject({ typeName: 'Thing', members: { Name: { get: ()=>progId } } }));
        },
        getObject: path=>hostObject({ members: { Path: { get: ()=>path } } }),
    });
    await engine.run(`
        Set o = CreateObject("Scripting.Thing")
        out = o.Name & TypeName(o) & GetObject("winmgmts:").Path
        On Error Resume Next
        Set p = CreateObject("Missing.Class")
        out = out & "|" & Err.Number & ":" & Err.Description
    `);
    assert.equal(engine.getGlobal('out'),
        'Scripting.ThingThingwinmgmts:|429:ActiveX component can\'t create object');
    assert.deepEqual(asked, [['Scripting.Thing', undefined], ['Missing.Class', undefined]]);
    await assert.rejects(createVBScriptEngine().run('Set o = CreateObject("X.Y")'),
        e=>e instanceof VBScriptError && e.number === 429);
});

test('the items whose members are global, and names the host makes when used', async()=>{
    const engine = createVBScriptEngine();
    engine.addGlobalMembers(hostObject({ members: {
        Echo: { call: ([text])=>`echo ${text}` },
        Version: { get: ()=>later(3) },
    } }));
    /** @type {string[]} */
    const resolved = [];
    engine.setNameResolver(name=>{
        resolved.push(name);
        return name === 'Host' ? later(hostObject({ members: { Id: { get: ()=>7 } } }))
            : undefined;
    });
    await engine.run('out = Echo("x") & Version & Host.Id & Host.Id & IsEmpty(Unknown)');
    assert.equal(engine.getGlobal('out'), 'echo x377True');
    // Each name nothing defines is asked for once; Host is then the host's.
    assert.deepEqual(resolved, ['Host', 'Unknown', 'out']);
    await assert.rejects(engine.run('Echo = 1'), e=>e instanceof VBScriptError);
});

test('JScript and VBScript face an embedder alike', async()=>{
    const scripts = {
        jscript: 'function Action(name) { Session.Property("OUT") = Session.Property(name) + "!";'
            + ' return 3; }',
        vbscript: 'Function Action(name)\nSession.Property("OUT") = Session.Property(name) & "!"\n'
            + 'Action = 3\nEnd Function',
    };
    const engines = { jscript: createJScriptEngine(), vbscript: createVBScriptEngine() };
    for (const language of /** @type {const} */ (['jscript', 'vbscript']))
    {
        const { object, properties } = session();
        const engine = engines[language];
        engine.addNamedItem('Session', object);
        await engine.run(scripts[language]);
        assert.equal(await engine.call('Action', ['ProductName']), 3, language);
        assert.equal(properties.get('OUT'), 'Example!', language);
        assert.equal(await engine.run('1 + 2', { expression: true }), 3, language);
        const failed = await engine.run('Session.Nope()').then(()=>null, e=>e);
        assert.ok(failed instanceof ScriptError, language);
        assert.equal(typeof failed.number, 'number');
        assert.equal(typeof failed.scode, 'number');
    }
});

test('an argument left out reaches an external object as DISP_E_PARAMNOTFOUND', async()=>{
    /** @type {unknown[]} */
    let seen = [];
    const engine = createVBScriptEngine();
    engine.addNamedItem('Host', hostObject({ members: {
        Take: { call: args=>{
            seen = args;
            return 0;
        } },
    } }));
    await engine.run('Host.Take 1, , 3');
    assert.equal(seen.length, 3);
    assert.equal(/** @type {any} */ (seen[1]).value, 0x80020004 | 0);
    await assert.rejects(engine.run('Host.Nothing'),
        e=>e instanceof VBScriptError && e.number === 438);
    assert.equal(DISP_E_UNKNOWNNAME, 0x80020006 | 0);
    assert.equal(DISP_E_EXCEPTION, 0x80020009 | 0);
});
