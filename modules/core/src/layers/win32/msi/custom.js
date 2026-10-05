/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Custom actions: the program's own steps in its installation.
 *
 * A CustomAction row's type says what the action is in its low bits -- a
 * library or a program, from the Binary table, an installed file, a
 * directory or a property; a property or directory to set; an error to
 * show -- and how it runs in the rest: whether its answer is ignored, whether
 * it waits, whether it runs once only, and whether it runs now or is written
 * into the script for InstallFinalize, where it sees only the
 * CustomActionData the action's own property held when it was scheduled.
 *
 * A library action is the program's code, given the session's handle and
 * answering an error code; its library is written to the temporary folder
 * from the Binary table first, as Windows does. Scripts in VBScript or
 * JScript need a script engine this machine does not have.
 */

/** The type's low bits: what the action is. */
const TYPE_DLL = 1;
const TYPE_EXE = 2;
const TYPE_TEXT = 3;
const TYPE_JSCRIPT = 5;
const TYPE_VBSCRIPT = 6;
const TYPE_INSTALL = 7;
/** And where its source comes from, in the next two bits. */
const SOURCE_BINARY = 0x00;
const SOURCE_FILE = 0x10;
const SOURCE_DIRECTORY = 0x20;
const SOURCE_PROPERTY = 0x30;

/** The flags above them. */
const CONTINUE = 0x40;
const ASYNC = 0x80;
const FIRST_SEQUENCE = 0x100;
const ONCE_PER_PROCESS = 0x200;
const CLIENT_REPEAT = 0x300;
const IN_SCRIPT = 0x400;
const ROLLBACK = 0x100;
const COMMIT = 0x200;

const ERROR_SUCCESS = 0;
const ERROR_FUNCTION_NOT_CALLED = 1626;
const ERROR_INSTALL_FAILURE = 1603;
const ERROR_INSTALL_USEREXIT = 1602;
const ERROR_INSTALL_SUSPEND = 1604;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_MORE_DATA = 234;
/** What a library action answers to say "the action did nothing". */
const ERROR_CREATE_FAILED = 1631;

/** INSTALLMESSAGE_ERROR, for a type 19 action's text. */
const INSTALLMESSAGE_ERROR = 0x01000000;

/** Numbers temporary libraries are named by, as MSIxxxx.tmp. */
let temporaryNumber = 0x1a2b;

/**
 * @typedef {{ action: string, type: number, source: string | null,
 *     target: string | null }} CustomRow
 */

/**
 * A library action's answer as the sequence reads it: success and the
 * answers that mean "skip the rest" or "stop" kept, anything else a failure.
 *
 * @param {number} code
 */
function sequenceAnswer(code){
    switch (code)
    {
        case ERROR_SUCCESS:
        case ERROR_INSTALL_USEREXIT:
        case ERROR_INSTALL_SUSPEND:
        case ERROR_NO_MORE_ITEMS:
            return code;
        case ERROR_FUNCTION_NOT_CALLED:
        case ERROR_CREATE_FAILED:
        case ERROR_MORE_DATA:
            return ERROR_SUCCESS;
        default:
            return ERROR_INSTALL_FAILURE;
    }
}

/**
 * Runs a custom action now, or writes it into the script.
 *
 * @param {import('./actions.js').Engine} engine @param {CustomRow} row
 * @returns {Promise<number>}
 */
export async function runCustomAction(engine, row){
    const { session } = engine;
    const kind = row.type & 0x3f;
    const flags = row.type & ~0x3f;

    if ((flags & IN_SCRIPT) !== 0)
    {
        if ((flags & ROLLBACK) !== 0 && (flags & COMMIT) === 0)
        {
            // A rollback action runs only when the installation is undone,
            // and nothing here is undone.
            return ERROR_SUCCESS;
        }
        const data = session.getProperty(row.action);
        const step = { name: row.action, run: ()=>execute(engine, row, kind, flags, data) };
        if ((flags & COMMIT) !== 0 && (flags & ROLLBACK) === 0)
        {
            engine.commit.push(step);
            return ERROR_SUCCESS;
        }
        if (!session.mode.scheduled)
        {
            // Deferred, but no script is being written: as Windows, it runs
            // at once with what it would have been given.
            return step.run();
        }
        session.script.push(step);
        return ERROR_SUCCESS;
    }

    // The once-only kinds: the first sequence that runs the action is the
    // only one, or one run per process, or the client's run repeated.
    const scheduling = flags & CLIENT_REPEAT;
    if (scheduling !== 0 && engine.ran.has(row.action))
    {
        if (scheduling === FIRST_SEQUENCE || scheduling === ONCE_PER_PROCESS
            || (scheduling === CLIENT_REPEAT && engine.executing))
        {
            return ERROR_SUCCESS;
        }
    }
    engine.ran.add(row.action);
    return execute(engine, row, kind, flags, null);
}

/**
 * @param {import('./actions.js').Engine} engine @param {CustomRow} row
 * @param {number} kind @param {number} flags @param {string | null} data
 *        The CustomActionData of a deferred action; null for an immediate one.
 * @returns {Promise<number>}
 */
async function execute(engine, row, kind, flags, data){
    const { session, host } = engine;
    const type = kind & 0x07;
    const source = kind & 0x30;
    const ignore = (flags & CONTINUE) !== 0;
    /** @param {number} code */
    const answer = code=>(ignore ? ERROR_SUCCESS : code);
    /** @param {string} text */
    const format = text=>session.formatText(text);

    // Setting a property or a directory, and showing an error.
    if (kind === (TYPE_TEXT | SOURCE_PROPERTY) || kind === 51)
    {
        session.setProperty(row.source ?? '', format(row.target ?? ''));
        return ERROR_SUCCESS;
    }
    if (kind === (TYPE_TEXT | SOURCE_DIRECTORY) || kind === 35)
    {
        session.setTargetPath(row.source ?? '', format(row.target ?? ''));
        return ERROR_SUCCESS;
    }
    if (kind === (TYPE_TEXT | SOURCE_FILE) || kind === 19)
    {
        const row19 = session.db.table('Error')?.rows.find(entry=>String(entry[0])
            === row.target);
        const text = format(String(row19?.[1] ?? row.target ?? ''));
        const record = { fields: [text] };
        await host.message(INSTALLMESSAGE_ERROR, record);
        return ERROR_INSTALL_FAILURE;
    }

    if (type === TYPE_DLL)
    {
        let path = null;
        let temporary = false;
        if (source === SOURCE_BINARY)
        {
            path = await binaryToFile(engine, row.source ?? '');
            temporary = path !== null;
        }
        else if (source === SOURCE_FILE)
        {
            path = session.files.get(row.source ?? '')?.target ?? null;
        }
        if (!path)
        {
            host.log?.(`Custom action ${row.action}: no library ${row.source}.`);
            return answer(ERROR_INSTALL_FAILURE);
        }
        const handle = host.openHandle(session, data);
        if ((flags & ASYNC) !== 0)
        {
            // In parallel with the sequence: the library's code is on a thread
            // of its own, and what it was given stays until it is over.
            const started = await host.startDll(path, row.target ?? '', [handle]);
            const release = ()=>{
                host.closeHandle(handle);
                if (temporary)
                {
                    host.files.remove(path);
                }
            };
            if (!started)
            {
                release();
                host.log?.(`Custom action ${row.action} could not be started.`);
                return answer(ERROR_INSTALL_FAILURE);
            }
            host.log?.(`Custom action ${row.action} started.`);
            const action = { name: row.action, wait: !ignore, over: false, stop: started.stop,
                done: started.done.finally(()=>{
                    action.over = true;
                    release();
                }) };
            engine.async.push(action);
            return ERROR_SUCCESS;
        }
        try
        {
            const code = await host.callDll(path, row.target ?? '', [handle]);
            host.log?.(`Custom action ${row.action} answered ${code}.`);
            return answer(code === null ? ERROR_INSTALL_FAILURE : sequenceAnswer(code >>> 0));
        }
        finally
        {
            host.closeHandle(handle);
            if (temporary)
            {
                host.files.remove(path);
            }
        }
    }

    if (type === TYPE_EXE)
    {
        /** @type {string | null} */
        let commandLine;
        /** @type {string | null} */
        let directory = null;
        if (source === SOURCE_BINARY)
        {
            const path = await binaryToFile(engine, row.source ?? '', '.exe');
            commandLine = path ? `"${path}" ${format(row.target ?? '')}` : null;
        }
        else if (source === SOURCE_FILE)
        {
            const path = session.files.get(row.source ?? '')?.target;
            commandLine = path ? `"${path}" ${format(row.target ?? '')}` : null;
        }
        else if (source === SOURCE_DIRECTORY)
        {
            directory = session.folders.get(row.source ?? '')?.target
                ?? session.getProperty(row.source ?? '');
            commandLine = format(row.target ?? '');
        }
        else
        {
            const path = session.getProperty(row.source ?? '');
            commandLine = path ? `"${path}" ${format(row.target ?? '')}` : null;
        }
        if (!commandLine)
        {
            return answer(ERROR_INSTALL_FAILURE);
        }
        const wait = (flags & ASYNC) === 0;
        const code = await host.runExe(commandLine, directory, wait);
        if (code === null)
        {
            return answer(ERROR_INSTALL_FAILURE);
        }
        return answer(wait && code !== 0 ? ERROR_INSTALL_FAILURE : ERROR_SUCCESS);
    }

    if (type === TYPE_JSCRIPT || type === TYPE_VBSCRIPT)
    {
        host.divergence?.(`custom action ${row.action}`,
            'a script action needs a script engine, which this machine has none of');
        return answer(ERROR_INSTALL_FAILURE);
    }
    if (type === TYPE_INSTALL)
    {
        host.divergence?.(`custom action ${row.action}`,
            'a nested installation is not run');
        return answer(ERROR_INSTALL_FAILURE);
    }
    return answer(ERROR_FUNCTION_NOT_CALLED);
}

/**
 * The end of an installation for the actions that ran beside it: the ones it
 * waits for are waited for, and a failure of one is the installation's; the
 * rest are stopped if they have not finished, as Windows ends them with the
 * installation.
 *
 * @param {import('./actions.js').Engine} engine
 * @returns {Promise<number>} the failure of one that was waited for, or success
 */
export async function finishAsync(engine){
    let failure = ERROR_SUCCESS;
    for (const action of engine.async.splice(0))
    {
        if (action.wait)
        {
            const code = await action.done;
            engine.host.log?.(`Custom action ${action.name} answered ${code}.`);
            if (code === null || sequenceAnswer(code >>> 0) === ERROR_INSTALL_FAILURE)
            {
                failure = code ?? ERROR_INSTALL_FAILURE;
            }
        }
        else
        {
            if (!action.over)
            {
                action.stop();
            }
            await action.done;
        }
    }
    return failure;
}

/**
 * Writes a Binary row's stream to the temporary folder, as Windows does
 * before it loads a library action.
 *
 * @param {import('./actions.js').Engine} engine @param {string} key
 * @param {string} [extension]
 * @returns {Promise<string | null>}
 */
async function binaryToFile(engine, key, extension = '.tmp'){
    const { session, host } = engine;
    const bytes = await session.db.readStream(`Binary.${key}`);
    if (!bytes)
    {
        return null;
    }
    const folder = session.getProperty('TempFolder') || 'C:\\WINDOWS\\TEMP\\';
    const path = `${folder}MSI${(temporaryNumber++ & 0xffff).toString(16).toUpperCase()}`
        + `${extension}`;
    const node = host.files.open(path, { read: false, write: true, create: true, truncate: true });
    if (!node)
    {
        return null;
    }
    host.files.write(node, 0, bytes);
    host.files.close(node);
    return path;
}
