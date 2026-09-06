/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Page side: pick an executable, hand it to the worker, render what comes back.
 *
 * Holds no engine state of its own — whatever is shown here came out of a
 * message, so the page cannot drift from what the guest actually did.
 */

const FIXTURE = '../modules/core/test/fixtures/hello.exe';

const runButton = document.querySelector('#run');
const filePicker = document.querySelector('#file');
const statusLine = document.querySelector('#status');
const outputPane = document.querySelector('#output');
const diagnosticsPane = document.querySelector('#diagnostics');

/** @param {string} text @param {string} [kind] */
function status(text, kind = ''){
    statusLine.textContent = text;
    statusLine.className = kind;
}

/** @param {boolean} busy */
function setBusy(busy){
    runButton.disabled = busy;
    filePicker.disabled = busy;
}

/** @param {number} value */
const hex = value=>`0x${(value >>> 0).toString(16)}`;

/**
 * Renders one metric value. Arrays are the interesting case: the memory layout
 * and the import lists are arrays, and they are worth reading line by line.
 *
 * @param {any} value
 * @returns {string}
 */
function formatValue(value){
    if (Array.isArray(value))
    {
        return value.length === 0 ? '—' : `\n    ${value.join('\n    ')}`;
    }
    return String(value);
}

/** @param {any[]} modules */
function renderDiagnostics(modules){
    if (!modules || modules.length === 0)
    {
        diagnosticsPane.className = 'empty';
        diagnosticsPane.textContent = 'no snapshot';
        return;
    }

    diagnosticsPane.className = '';
    diagnosticsPane.replaceChildren(...modules.map(module=>{
        const row = document.createElement('div');
        row.className = 'module';

        const head = document.createElement('div');
        head.className = 'module-head';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = module.name;
        const badge = document.createElement('span');
        badge.className = `badge ${module.status}`;
        badge.textContent = module.status;
        head.append(name, badge);
        row.append(head);

        const metrics = module.metrics ?? {};
        const lines = Object.entries(metrics)
            .map(([key, value])=>`${key}: ${formatValue(value)}`);
        if (lines.length > 0)
        {
            const body = document.createElement('pre');
            body.className = 'metrics';
            body.textContent = lines.join('\n');
            row.append(body);
        }
        return row;
    }));
}

/** @param {Uint8Array} executable @param {string} label */
function runExecutable(executable, label){
    setBusy(true);
    status(`Running ${label}…`);
    outputPane.className = 'empty';
    outputPane.textContent = 'nothing yet';
    diagnosticsPane.className = 'empty';
    diagnosticsPane.textContent = 'nothing yet';

    const worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
    let output = '';

    worker.onmessage = event=>{
        const message = event.data;

        if (message.type === 'output')
        {
            output += message.text;
            outputPane.className = '';
            outputPane.textContent = output;
            return;
        }

        if (message.type === 'loaded')
        {
            const { base, entryPoint, unresolved } = message.image;
            status(`Mapped at ${hex(base)}, entry ${hex(entryPoint)}…`);
            if (unresolved.length > 0)
            {
                // Not fatal at load time, which is exactly why it needs saying now.
                status(`Unimplemented imports: ${unresolved.join(', ')}`, 'bad');
            }
            return;
        }

        if (message.type === 'exited')
        {
            renderDiagnostics(message.diagnostics);
            const clean = message.exitCode === 0;
            status(`${label} exited with code ${message.exitCode}.`, clean ? 'ok' : 'bad');
            setBusy(false);
            worker.terminate();
            return;
        }

        if (message.type === 'failed')
        {
            renderDiagnostics(message.diagnostics);
            status(`${label} failed: ${message.message}`, 'bad');
            setBusy(false);
            worker.terminate();
        }
    };

    worker.onerror = event=>{
        status(`worker error: ${event.message}`, 'bad');
        setBusy(false);
        worker.terminate();
    };

    const buffer = executable.buffer.slice(
        executable.byteOffset, executable.byteOffset + executable.byteLength);
    worker.postMessage({ executable: buffer, timeoutMs: 8000 }, [buffer]);
}

runButton.addEventListener('click', async()=>{
    try {
        const response = await fetch(new URL(FIXTURE, import.meta.url));
        if (!response.ok)
        {
            throw new Error(`fixture: HTTP ${response.status}`);
        }
        runExecutable(new Uint8Array(await response.arrayBuffer()), 'hello.exe');
    } catch (e){
        status(`could not load the fixture: ${e.message}`, 'bad');
    }
});

filePicker.addEventListener('change', async()=>{
    const file = filePicker.files?.[0];
    if (!file)
    {
        return;
    }
    runExecutable(new Uint8Array(await file.arrayBuffer()), file.name);
    filePicker.value = '';
});
