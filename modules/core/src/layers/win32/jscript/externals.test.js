/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DISP_E_EXCEPTION, ExternalError, ExternalObject, hostObject,
} from '../script/external.js';
import { arrayValue, dateValue, variantArray } from '../script/values.js';
import { VT_VARIANT } from '../oleaut32/vartypes.js';
import { JScriptError, createJScriptEngine } from './engine.js';

/** @param {number} code */
const hr = code=>(0x800a0000 | code) | 0;

/** A value a moment later, as a guest object answers. @template T @param {T} value */
const later = value=>new Promise(done=>setImmediate(()=>done(value)));

/**
 * An installer's Session as a custom action sees it: a property store
 * reached through a parameterised property, and a log of messages.
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
                    throw new ExternalError(DISP_E_EXCEPTION, 'the installer said no', 'Msi');
                },
            },
        },
        value: { get: ()=>'[Session]' },
        items: ()=>['first', 'second'],
    });
    return { object, properties, messages };
}

test('a custom action: Session.Property read and set, a function called by name', async()=>{
    for (const async of [false, true])
    {
        const { object, properties, messages } = session({ async });
        const engine = createJScriptEngine();
        engine.addNamedItem('Session', object);
        await engine.run(`
            var name = Session.Property("ProductName");
            function CheckIt()
            {
                Session.Property("CHECKED") = name + " checked";
                Session.property("COUNT") = 2;
                Session.Message(0x01000000, "hello");
                return 1;
            }`);
        assert.equal(await engine.call('CheckIt'), 1);
        assert.equal(properties.get('CHECKED'), 'Example checked');
        assert.equal(properties.get('COUNT'), '2');
        assert.deepEqual(messages, [[0x01000000, 'hello']]);
    }
});

test('a compound assignment to a parameterised property reads, then writes', async()=>{
    const { object, properties } = session({ async: true });
    const engine = createJScriptEngine();
    engine.addNamedItem('Session', object);
    await engine.run('Session.Property("ProductName") += "!"');
    assert.equal(properties.get('ProductName'), 'Example!');
});

test('an external object\'s failures are JScript errors the script can catch', async()=>{
    const { object } = session();
    const engine = createJScriptEngine();
    engine.addNamedItem('Session', object);
    assert.equal(await engine.run(
        'try { Session.Fail() } catch (e) { e.number + "|" + e.description }'),
    `${DISP_E_EXCEPTION}|the installer said no`);
    assert.equal(await engine.run('try { Session.Nothing() } catch (e) { e.number }'), hr(438));
    await assert.rejects(engine.run('Session.Fail()'), e=>e instanceof JScriptError
        && e.description === 'the installer said no');
});

test('an external object as a value: typeof, default member, for-in, Enumerator, with',
    async()=>{
        const { object } = session({ async: true });
        const engine = createJScriptEngine();
        engine.addNamedItem('Session', object);
        assert.equal(await engine.run('typeof Session'), 'object');
        assert.equal(await engine.run('"is " + Session'), 'is [Session]');
        assert.equal(await engine.run('var s = ""; for (var k in Session) s += k + ","; s'),
            'Property,Message,Fail,');
        assert.equal(await engine.run(
            'var e = new Enumerator(Session), s = ""; for (; !e.atEnd(); e.moveNext())'
            + ' s += e.item(); e.moveFirst(); s + e.item()'), 'firstsecondfirst');
        assert.equal(await engine.run('with (Session) { Property("ProductName") }'), 'Example');
        assert.equal(await engine.run('"Message" in Session'), true);
        assert.equal(await engine.run('try { new Enumerator([1]) } catch (e) { e.number }'),
            hr(451));
    });

test('a global-members object\'s members are global names, found after the script\'s',
    async()=>{
        /** @type {string[]} */
        const echoed = [];
        const host = hostObject({ members: {
            Echo: { call: ([text])=>{
                echoed.push(String(text));
                return later(undefined);
            } },
            Version: { get: ()=>later('1.0') },
        } });
        const engine = createJScriptEngine();
        engine.addGlobalMembers(host);
        await engine.run('Echo("v" + Version)');
        // A var is the global object's from the start of its text, ahead of
        // the item's member of the same name.
        await engine.run('Echo(typeof Version); var Version = "mine"; Echo(Version)');
        assert.deepEqual(echoed, ['v1.0', 'undefined', 'mine']);
        await assert.rejects(engine.run('Missing()'), e=>e instanceof JScriptError
            && e.number === hr(5009));
    });

test('names the host resolves when first used, and may answer later', async()=>{
    /** @type {string[]} */
    const asked = [];
    const engine = createJScriptEngine();
    engine.setNameResolver(name=>{
        asked.push(name);
        return name === 'Lazy' ? later(hostObject({ members: { V: { get: ()=>7 } } }))
            : undefined;
    });
    assert.equal(await engine.run('Lazy.V * 6'), 42);
    assert.equal(await engine.run('typeof Unknown'), 'undefined');
    assert.deepEqual(asked, ['Lazy', 'Unknown']);
});

test('ActiveXObject creates through the embedder; a class it cannot is error 429', async()=>{
    /** @type {string[]} */
    const created = [];
    const engine = createJScriptEngine({
        createObject: progId=>{
            created.push(progId);
            if (progId !== 'Scripting.Thing')
            {
                throw new ExternalError(0x80040154 | 0);
            }
            return later(hostObject({ members: { Name: { get: ()=>'thing' } } }));
        },
    });
    assert.equal(await engine.run('new ActiveXObject("Scripting.Thing").Name'), 'thing');
    assert.equal(await engine.run(
        'try { new ActiveXObject("No.Such") } catch (e) { e.number + e.description }'),
    `${hr(429)}Automation server can't create object`);
    assert.deepEqual(created, ['Scripting.Thing', 'No.Such']);

    /** @type {string[]} */
    const reported = [];
    const bare = createJScriptEngine({
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
    });
    assert.equal(await bare.run('try { new ActiveXObject("X.Y") } catch (e) { e.number }'),
        hr(429));
    assert.equal(await bare.run('try { GetObject("c:\\\\file.xls") } catch (e) { e.number }'),
        hr(429));
    assert.equal(reported.length, 2);
});

test('VBArray reads a SAFEARRAY; a date VARIANT is a date', async()=>{
    const engine = createJScriptEngine({ localOffset: ()=>0 });
    engine.addNamedItem('list', variantArray(['a', 'b', 'c']));
    // 2 by 3, the first index varying fastest, the second dimension from 1.
    engine.addNamedItem('grid', arrayValue({ elementType: VT_VARIANT,
        bounds: [{ lower: 0, count: 2 }, { lower: 1, count: 3 }], items: [1, 2, 3, 4, 5, 6] }));
    engine.addNamedItem('when', dateValue(36526.25));
    assert.equal(await engine.run('new VBArray(list).toArray().join()'), 'a,b,c');
    assert.equal(await engine.run('typeof list'), 'unknown');
    assert.equal(await engine.run(
        'var v = new VBArray(grid); v.dimensions() + "|" + v.lbound(2) + "|" + v.ubound(2)'
        + ' + "|" + v.getItem(1, 2) + "|" + v.toArray().join()'), '2|1|3|4|1,2,3,4,5,6');
    assert.equal(await engine.run('try { new VBArray(grid).getItem(2, 1) } catch (e) { e.number }'),
        hr(9));
    assert.equal(await engine.run('try { new VBArray([1]) } catch (e) { e.number }'), hr(5013));
    assert.equal(await engine.run('typeof when'), 'date');
    assert.equal(await engine.run('new Date(when).toUTCString()'),
        'Sat, 1 Jan 2000 06:00:00 UTC');
});

test('a script function handed to an external object can be called back', async()=>{
    /** @type {unknown} */
    let callback;
    const host = hostObject({ members: {
        OnDone: { put: value=>{
            callback = value;
        } },
    } });
    const engine = createJScriptEngine();
    engine.addNamedItem('Host', host);
    await engine.run('var hits = 0; Host.OnDone = function(n){ hits += n; return "ok" }');
    assert.ok(engine.isCallable(callback));
    assert.equal(await engine.callFunction(callback, undefined, [5]), 'ok');
    assert.equal(engine.global.get('hits'), 5);
});

test('ExternalObject\'s own refusals say which member', ()=>{
    const bare = new ExternalObject();
    assert.throws(()=>bare.get('Name', []), e=>e instanceof ExternalError
        && /Name cannot be read/.test(e.description));
    assert.equal(bare.has('anything'), false);
});
