/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Copies a bottle installed in a browser (the launcher's OPFS, `bottles/<id>/`)
 * into this tree's `bundles/<id>/`, so the harness and the node tools can run
 * it. It reads only: the browser is reached over DevTools on a port, the
 * launcher tab's file handed over as a blob stream (IO.resolveBlob, IO.read),
 * so a game of gigabytes is not encoded in the page.
 *
 *     node tools/pull-bottle.mjs <bottle id> [--port 9333] [--origin https://127.0.0.1:5180]
 *     node tools/pull-bottle.mjs --list [--port 9333]
 */

import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const option = (name, fallback)=>(argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const port = option('--port', '9333');
const origin = option('--origin', 'https://127.0.0.1:5180');
const id = argv.find(arg=>!arg.startsWith('--') && arg !== port && arg !== origin);
const BUNDLES = fileURLToPath(new URL('../bundles/', import.meta.url));

const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab = tabs.find((/** @type {any} */ one)=>one.type === 'page' && one.url.startsWith(origin));
if (!tab)
{
    console.error(`no tab of ${origin} on port ${port}`);
    process.exit(1);
}
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(open=>socket.addEventListener('open', open, { once: true }));
let next = 0;
/** @type {Map<number, (message: any) => void>} */
const waiting = new Map();
socket.addEventListener('message', event=>{
    const message = JSON.parse(String(event.data));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
});
/** @param {string} method @param {object} [params] @returns {Promise<any>} */
const send = (method, params = {})=>new Promise((resolve, reject)=>{
    const at = ++next;
    waiting.set(at, message=>(message.error
        ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
    socket.send(JSON.stringify({ id: at, method, params }));
});
/** @param {string} expression @param {boolean} [byValue] */
const evaluate = async(expression, byValue = true)=>{
    const answer = await send('Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: byValue });
    if (answer.exceptionDetails)
    {
        throw new Error(answer.exceptionDetails.exception?.description
            ?? answer.exceptionDetails.text);
    }
    return answer.result;
};

const folder = `(await (await navigator.storage.getDirectory()).getDirectoryHandle('bottles'))`;
if (argv.includes('--list') || !id)
{
    const listed = await evaluate(`(async () => { const out = [];
        for await (const [name, handle] of ${folder}.entries()) {
            if (handle.kind !== 'directory') continue;
            const files = [];
            for await (const [file, entry] of handle.entries())
                if (entry.kind === 'file') files.push(file + ' ' + (await entry.getFile()).size);
            out.push(name + ': ' + files.join(', '));
        }
        return out; })()`);
    console.log(listed.value.join('\n') || 'no bottles');
    process.exit(0);
}

const into = join(BUNDLES, id);
mkdirSync(into, { recursive: true });
for (const name of ['manifest.json', 'bundle.btl'])
{
    const file = await evaluate(`(async () => (await (await ${folder}.getDirectoryHandle(
        ${JSON.stringify(id)})).getFileHandle(${JSON.stringify(name)})).getFile())()`, false);
    const { uuid } = await send('IO.resolveBlob', { objectId: file.objectId });
    const handle = `blob:${uuid}`;
    const out = createWriteStream(join(into, name));
    let bytes = 0;
    let shown = 0;
    for (;;)
    {
        const piece = await send('IO.read', { handle, size: 8 << 20 });
        const chunk = Buffer.from(piece.data, piece.base64Encoded ? 'base64' : 'utf8');
        bytes += chunk.length;
        if (!out.write(chunk))
        {
            await new Promise(drained=>out.once('drain', drained));
        }
        if (bytes - shown >= 256 << 20)
        {
            shown = bytes;
            console.log(`${name}: ${Math.round(bytes / 2 ** 20)} MiB`);
        }
        if (piece.eof)
        {
            break;
        }
    }
    await send('IO.close', { handle });
    await new Promise(done=>out.end(done));
    console.log(`${name}: ${bytes} bytes`);
}
// The manifest a browser keeps names its bundle as its own; here it is the file beside it.
const manifestPath = join(into, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.id = id;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
console.log(`bundles/${id}: done`);
process.exit(0);
