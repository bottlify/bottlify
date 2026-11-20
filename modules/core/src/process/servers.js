/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * servers - the class servers COM starts beside the process that asked for
 * one: the executable its command line names, run with -Embedding until it
 * exits.
 */

/**
 * @param {Record<string, any>} deps  the parts of the process it works on, by the names `app.js`
 *     gives them; asked for, since they are made or set later:
 *     `current`, `noteMachines`, `runOptionsNow`, `runProcesses`,
 *     `stand`, `standingBeside`
 */
export function classServers(deps){
    const {
        bindLogLevels, build, events, keepMemory, newProcessIds, ownSound, retire, serving,
    } = deps;
    const {
        current, noteMachines, runOptionsNow, runProcesses, stand, standingBeside,
    } = deps;

    /**
     * The executable a server's command line names: quoted, the text inside
     * the quotes; unquoted, the shortest run of words up to a space that is a
     * file, as CreateProcess reads a command line without quotes.
     *
     * @param {any} parent @param {string} command
     * @returns {Promise<{ path: string, image: Uint8Array } | null>}
     */
    const serverImage = async(parent, command)=>{
        const text = command.trim();
        /** @type {string[]} */
        const candidates = [];
        if (text.startsWith('"'))
        {
            const end = text.indexOf('"', 1);
            candidates.push(end > 0 ? text.slice(1, end) : text.slice(1));
        }
        else
        {
            for (let at = text.indexOf(' '); at > 0; at = text.indexOf(' ', at + 1))
            {
                candidates.push(text.slice(0, at));
            }
            candidates.push(text);
        }
        for (const path of candidates.flatMap(one=>(/\.[^\\.]+$/.test(one)
            ? [one] : [one, `${one}.exe`])))
        {
            const image = await parent.readImage(path).catch(()=>null);
            if (image)
            {
                return { path, image };
            }
        }
        return null;
    };

    /**
     * Starts a class's server beside the process that asked for it, with
     * `-Embedding` after its command line as COM starts one, and runs it
     * alongside every other process until it exits. The page sees and
     * drives the server while it stands, as it does a child run beside its
     * parent.
     *
     * @param {any} parent @param {{ command: string, clsid: string, service?: string }} request
     * @returns {Promise<number>} its exit code
     */
    const startServer = async(parent, request)=>{
        const found = await serverImage(parent, request.command);
        const sound = ownSound();
        if (!found)
        {
            events.emit('divergence', { api: 'COM',
                detail: `the server ${request.command} of ${request.clsid} is not on the volume` });
            return -1;
        }
        const ids = newProcessIds();
        const server = await build({
            executable: found.image,
            imagePath: found.path,
            // A service is started as the manager starts it, on its image's line alone.
            commandLine: request.service ? request.command.trim()
                : `${request.command.trim()} -Embedding`,
            ...request.service ? { service: request.service } : {},
            ...ids,
            audio: sound.options,
            startedBeside: true,
        });
        sound.announce(server);
        // A line of processes of its own: a server that starts a child and
        // waits on it, or hands over to another image, is run the way the
        // program the page started is.
        const line = { current: server, main: false, service: request.service ?? null };
        serving.add(line);
        const listed = { id: ids.processId, image: found.path, beside: /** @type {true} */ (true),
            diagnostics: ()=>line.current.diagnostics(),
            read: (/** @type {number} */ address, /** @type {number} */ length)=>
                line.current.debug.read(address, length),
            hook: (/** @type {number} */ address, /** @type {any} */ how)=>
                line.current.debug.hook(address, how) };
        standingBeside().add(listed);
        noteMachines()();
        events.emit('process-server', { image: found.path, clsid: request.clsid });
        stand()(server);
        bindLogLevels();
        let code = -1;
        try
        {
            code = await runProcesses()(runOptionsNow(), line, true);
        }
        catch (e){
            // A run the page ended under it is no failure of the server.
            if (/** @type {any} */ (e)?.reason !== 'disposed')
            {
                events.emit('error', { reason: 'server', error: e });
            }
        }
        standingBeside().delete(listed);
        await retire(line.current);
        serving.delete(line);
        noteMachines()();
        await line.current.dispose();
        keepMemory(line.current);
        sound.giveBack();
        stand()(current());
        bindLogLevels();
        events.emit('process-server-exit', { image: found.path, code });
        return code;
    };

    return {
        serverImage, startServer,

    };
}
