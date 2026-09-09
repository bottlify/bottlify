/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Winsock surface the guest calls, over the socket registry.
 *
 * This is translation and nothing else: handles into sockets, guest pointers
 * into addresses and buffers, outcomes into a return value plus an error slot.
 * Every decision about what a socket *does* is one layer down.
 *
 * Three things about the translation are worth stating, because each is a place
 * a faithful implementation looks wrong.
 *
 * The error slot is per thread. WSAGetLastError is documented that way and
 * programs rely on it: a worker thread that fails a call must not have its
 * reason overwritten by whatever the main thread did in between.
 *
 * A blocking call answers with a promise. The bridge suspends the guest thread
 * on one and resumes it with the result, which is the same machinery a file
 * read on an absent bundle block uses -- so a blocking recv costs a suspended
 * host call, not a spin.
 *
 * Anything read out of guest memory is read when the call is made, never when
 * it completes. Between those two moments the program is free to reuse the
 * buffer it passed, so a completion that goes back for the arguments finds
 * whatever is there now. The argument list itself is safe here -- the bridge
 * builds a fresh one per call -- but a WSABUF array behind a pointer is not,
 * and is copied at entry for exactly that reason.
 */

import {
    AF_INET, FIONBIO, FIONREAD, HOSTENT, INADDR_LOOPBACK, INADDR_NONE, INVALID_SOCKET,
    SOCKET_ERROR, SOL_SOCKET, SO_TYPE, WSADATA, WSADESCRIPTION, WSASYSSTATUS,
    WSAEAFNOSUPPORT, WSAEFAULT, WSAEINVAL, WSAENOTSOCK, WSAEMSGSIZE, WSAEOPNOTSUPP, WSAEWOULDBLOCK,
    WSAHOST_NOT_FOUND, WSANOTINITIALISED, WSA_IO_PENDING, WSOCK32_ORDINALS, WS2_32_ORDINALS,
} from './constants.js';
import {
    SOCKADDR_IN_SIZE, formatAddress, parseAddress, readSockaddr, swap16, swap32, writeSockaddr,
} from './sockaddr.js';

/** The name this host answers to, and the only one it can resolve to itself. */
const HOSTNAME = 'bottlify';

/** The one extension lookup a program makes before it settles for the plain calls. */
const SIO_GET_EXTENSION_FUNCTION_POINTER = 0xc8000006;

/**
 * @typedef {Object} WinsockHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {() => any} currentThread
 * @property {any} heap                 Allocates the buffers we hand back pointers to.
 * @property {any} registry             The socket registry.
 */

/**
 * @param {WinsockHost} host
 */
export function createWinsockFunctions(host){
    const { registry } = host;

    /**
     * The last error, per thread.
     *
     * Keyed by the thread object the kernel hands out rather than by an id,
     * because the object is what identifies a thread everywhere else here and
     * an id would be a second, quietly different, notion of the same thing.
     *
     * @type {Map<any, number>}
     */
    const errors = new Map();

    /** Whether WSAStartup has been called. Winsock refuses everything until it has. */
    let started = false;

    /** @param {number} code */
    const setError = code=>{
        errors.set(host.currentThread(), code >>> 0);
    };

    const lastError = ()=>errors.get(host.currentThread()) ?? 0;

    /** Fails a call: the error slot carries the reason, the return value only says "failed". */
    const fail = (/** @type {number} */ code, /** @type {number} */ result = SOCKET_ERROR)=>{
        setError(code);
        return result >>> 0;
    };

    /** Succeeds. The slot is not cleared -- Winsock leaves it alone on success. */
    const ok = (/** @type {number} */ result = 0)=>result >>> 0;

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address >>> 0, new Uint8Array([
            value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
        ]));
    };

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {string} text */
    const latin1 = text=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        return bytes;
    };

    /**
     * Resolves a handle, or reports that it is not a socket. A stale handle is
     * a return code and never a fault: programs do close a socket twice.
     *
     * @param {number} handle
     */
    const socketOf = handle=>registry.get(handle);

    /**
     * Every call but the four startup ones needs the library to have been
     * started, and Winsock is documented to say so rather than working anyway.
     */
    const needStarted = ()=>started ? null : WSANOTINITIALISED;

    /**
     * A buffer we allocate and keep, for the calls documented to return a
     * pointer into library memory. One per name, reused, because the contract
     * is that it stays valid until the next call and nothing says it moves.
     *
     * @type {Map<string, number>}
     */
    const statics = new Map();

    /** @param {string} name @param {number} bytes */
    const staticBuffer = (name, bytes)=>{
        const held = statics.get(name);
        if (held !== undefined)
        {
            return held;
        }
        const address = host.heap.allocate(bytes);
        statics.set(name, address);
        return address;
    };

    /**
     * Reads a WSABUF array as values, at call time.
     *
     * The array lives in guest memory the caller may reuse the moment this
     * returns, so what a later completion needs has to be taken now. This is
     * the whole of the async-callback invariant at this boundary.
     *
     * @param {number} pointer @param {number} count
     * @returns {{ pointer: number, length: number }[]}
     */
    const readBuffers = (pointer, count)=>{
        const buffers = [];
        for (let at = 0; at < count; at++)
        {
            const entry = (pointer >>> 0) + at * 8;
            buffers.push({ length: readDword(entry), pointer: readDword(entry + 4) });
        }
        return buffers;
    };

    /** How many bytes a WSABUF array offers in total. */
    const totalOf = (/** @type {{ length: number }[]} */ buffers)=>
        buffers.reduce((sum, buffer)=>sum + buffer.length, 0);

    /**
     * Spreads received bytes across a WSABUF array, in order.
     *
     * @param {{ pointer: number, length: number }[]} buffers
     * @param {Uint8Array} bytes
     */
    const scatter = (buffers, bytes)=>{
        let at = 0;
        for (const buffer of buffers)
        {
            if (at >= bytes.length)
            {
                break;
            }
            const part = bytes.subarray(at, at + buffer.length);
            host.writeMemory(buffer.pointer, part);
            at += part.length;
        }
    };

    /** Gathers a WSABUF array into one buffer. */
    const gather = (/** @type {{ pointer: number, length: number }[]} */ buffers)=>{
        const out = new Uint8Array(totalOf(buffers));
        let at = 0;
        for (const buffer of buffers)
        {
            out.set(host.readMemory(buffer.pointer, buffer.length), at);
            at += buffer.length;
        }
        return out;
    };

    /**
     * Waits for a socket to be able to answer, then answers.
     *
     * The attempt is retried rather than trusted after a wake-up, because a
     * wake-up says something changed and not that this caller is the one it
     * changed for -- two threads reading one socket both wake, and only one
     * finds bytes.
     *
     * @param {any} socket
     * @param {() => any} attempt  Returns an outcome, or an error of WSAEWOULDBLOCK.
     * @returns {Promise<any>}
     */
    const until = async(socket, attempt)=>{
        for (;;)
        {
            const outcome = attempt();
            if (outcome.error !== WSAEWOULDBLOCK)
            {
                return outcome;
            }
            if (socket.closed)
            {
                return { error: WSAENOTSOCK };
            }
            await registry.readableSoon(socket);
        }
    };

    /**
     * The shape every blocking call here shares: try it, and if it would block,
     * either say so or wait, depending on what the socket was set to.
     *
     * @param {any} socket
     * @param {() => any} attempt
     * @param {(outcome: any) => number} settle
     */
    const blocking = (socket, attempt, settle)=>{
        const outcome = attempt();
        if (outcome.error !== WSAEWOULDBLOCK)
        {
            return settle(outcome);
        }
        if (socket.nonBlocking)
        {
            return fail(WSAEWOULDBLOCK);
        }
        return until(socket, attempt).then(settle);
    };

    /**
     * Lays out a hostent and returns the pointer a caller gets back.
     *
     * One block holds the structure and everything it points at, so the pointers
     * stay valid exactly as long as the structure does -- which is until the
     * next call, the buffer being reused rather than reallocated.
     *
     * @param {string} name @param {number} address host order
     */
    const writeHostent = (name, address)=>{
        const block = staticBuffer('hostent', HOSTENT.SIZE + 64);
        const nameAt = block + HOSTENT.SIZE;
        const aliasesAt = nameAt + 32;
        const listAt = aliasesAt + 8;
        const addressAt = listAt + 8;

        host.writeMemory(nameAt, latin1(name));
        writeDword(aliasesAt, 0);
        writeDword(addressAt, swap32(address));
        writeDword(listAt, addressAt);
        writeDword(listAt + 4, 0);

        const record = new Uint8Array(HOSTENT.SIZE);
        const view = new DataView(record.buffer);
        view.setUint32(HOSTENT.h_name, nameAt, true);
        view.setUint32(HOSTENT.h_aliases, aliasesAt, true);
        view.setUint16(HOSTENT.h_addrtype, AF_INET, true);
        view.setUint16(HOSTENT.h_length, 4, true);
        view.setUint32(HOSTENT.h_addr_list, listAt, true);
        host.writeMemory(block, record);
        return block >>> 0;
    };

    /** fd_set is a count followed by that many handles. */
    const readFdSet = (/** @type {number} */ pointer)=>{
        if (pointer === 0)
        {
            return [];
        }
        const total = readDword(pointer);
        const handles = [];
        for (let at = 0; at < total; at++)
        {
            handles.push(readDword((pointer >>> 0) + 4 + at * 4));
        }
        return handles;
    };

    /**
     * Writes an fd_set back.
     *
     * The count the caller passed in is the array's capacity, and it is the only
     * thing that says how much room there is -- so more ready sockets than the
     * caller listed is a fault rather than a write past the end.
     *
     * @param {number} pointer @param {any[]} sockets
     */
    const writeFdSet = (pointer, sockets)=>{
        if (pointer === 0)
        {
            return true;
        }
        if (sockets.length > readDword(pointer))
        {
            return false;
        }
        writeDword(pointer, sockets.length);
        sockets.forEach((socket, at)=>writeDword((pointer >>> 0) + 4 + at * 4, socket.handle));
        return true;
    };

    /**
     * The socket calls, shared by wsock32 and ws2_32.
     *
     * One table and one registry, because they are one library as far as a
     * program is concerned: a socket made through either is usable through the
     * other, and on Windows they are the same sockets for the same reason.
     */
    /**
     * What ioctlsocket and WSAIoctl both do with a command: the argument is
     * read or written in place, so the buffered form hands in whichever of its
     * two buffers the command uses.
     *
     * @param {number} handle @param {number} command @param {number} argument
     */
    const ioctl = (handle, command, argument)=>{
        const socket = socketOf(handle);
        if (!socket)
        {
            return fail(WSAENOTSOCK);
        }
        if ((command >>> 0) === FIONBIO)
        {
            if (argument === 0)
            {
                return fail(WSAEFAULT);
            }
            socket.nonBlocking = readDword(argument) !== 0;
            return ok(0);
        }
        if ((command >>> 0) === FIONREAD)
        {
            if (argument === 0)
            {
                return fail(WSAEFAULT);
            }
            writeDword(argument, registry.available(socket));
            return ok(0);
        }
        return fail(WSAEINVAL);
    };

    const table = {
        WSAStartup: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([requested, data])=>{
                started = true;
                if (data !== 0)
                {
                    const block = new Uint8Array(WSADATA.SIZE);
                    const view = new DataView(block.buffer);
                    // The version negotiated is the one asked for, capped at
                    // what we implement; the high version is what we could do.
                    const asked = requested & 0xffff;
                    view.setUint16(WSADATA.wVersion, asked === 0 ? 0x0202 : asked, true);
                    view.setUint16(WSADATA.wHighVersion, 0x0202, true);
                    block.set(latin1(WSADESCRIPTION), WSADATA.szDescription);
                    block.set(latin1(WSASYSSTATUS), WSADATA.szSystemStatus);
                    view.setUint16(WSADATA.iMaxSockets, 0, true);
                    view.setUint16(WSADATA.iMaxUdpDg, 0, true);
                    host.writeMemory(data >>> 0, block);
                }
                return ok(0);
            },
        },

        WSACleanup: {
            argBytes: 0,
            handler: ()=>{
                for (const socket of registry.all())
                {
                    registry.close(socket);
                }
                started = false;
                return ok(0);
            },
        },

        WSAGetLastError: { argBytes: 0, handler: ()=>lastError() >>> 0 },

        WSASetLastError: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                setError(code);
                return 0;
            },
        },

        socket: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([family, type])=>{
                const missing = needStarted();
                if (missing !== null)
                {
                    return fail(missing, INVALID_SOCKET);
                }
                if (family !== AF_INET)
                {
                    return fail(WSAEAFNOSUPPORT, INVALID_SOCKET);
                }
                const made = registry.create(family, type);
                return made.error ? fail(made.error, INVALID_SOCKET) : ok(made.value);
            },
        },

        closesocket: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const outcome = registry.close(socket);
                return outcome.error ? fail(outcome.error) : ok(0);
            },
        },

        bind: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                if (length < SOCKADDR_IN_SIZE)
                {
                    return fail(WSAEFAULT);
                }
                const address = readSockaddr(host.readMemory, name);
                if (!address)
                {
                    return fail(WSAEFAULT);
                }
                if (address.family !== AF_INET)
                {
                    return fail(WSAEAFNOSUPPORT);
                }
                const outcome = registry.bind(socket, address);
                return outcome.error ? fail(outcome.error) : ok(0);
            },
        },

        listen: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const outcome = registry.listen(socket);
                return outcome.error ? fail(outcome.error) : ok(0);
            },
        },

        connect: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                if (length < SOCKADDR_IN_SIZE)
                {
                    return fail(WSAEFAULT);
                }
                const address = readSockaddr(host.readMemory, name);
                if (!address)
                {
                    return fail(WSAEFAULT);
                }
                // Reaching anything outside this runtime takes a round trip, so
                // the outcome may be a promise; the bridge parks the guest
                // thread on one, which is what a blocking connect does anyway.
                const settle = (/** @type {any} */ outcome)=>
                    outcome.error ? fail(outcome.error) : ok(0);
                const outcome = registry.connect(socket, address);
                return outcome instanceof Promise ? outcome.then(settle) : settle(outcome);
            },
        },

        accept: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, lengthPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK, INVALID_SOCKET);
                }
                return blocking(socket, ()=>registry.accept(socket), outcome=>{
                    if (outcome.error)
                    {
                        return fail(outcome.error, INVALID_SOCKET);
                    }
                    const accepted = registry.get(outcome.value);
                    if (name !== 0 && accepted?.remote)
                    {
                        writeSockaddr(host.writeMemory, name, accepted.remote);
                        if (lengthPointer !== 0)
                        {
                            writeDword(lengthPointer, SOCKADDR_IN_SIZE);
                        }
                    }
                    return ok(outcome.value);
                });
            },
        },

        send: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, buffer, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const bytes = host.readMemory(buffer >>> 0, length >>> 0);
                const outcome = registry.send(socket, bytes);
                return outcome.error ? fail(outcome.error) : ok(outcome.value);
            },
        },

        recv: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, buffer, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const wanted = length >>> 0;
                return blocking(socket, ()=>registry.receive(socket, wanted), outcome=>{
                    if (outcome.error)
                    {
                        return fail(outcome.error);
                    }
                    if (outcome.value > 0)
                    {
                        host.writeMemory(buffer >>> 0, outcome.bytes);
                    }
                    return ok(outcome.value);
                });
            },
        },

        sendto: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, , name])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const target = name === 0 ? null : readSockaddr(host.readMemory, name);
                if (name !== 0 && !target)
                {
                    return fail(WSAEFAULT);
                }
                const bytes = host.readMemory(buffer >>> 0, length >>> 0);
                const outcome = registry.send(socket, bytes, target);
                return outcome.error ? fail(outcome.error) : ok(outcome.value);
            },
        },

        recvfrom: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, , name, lengthPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const wanted = length >>> 0;
                return blocking(socket, ()=>registry.receive(socket, wanted), outcome=>{
                    if (outcome.error)
                    {
                        return fail(outcome.error);
                    }
                    if (outcome.value > 0)
                    {
                        host.writeMemory(buffer >>> 0, outcome.bytes);
                    }
                    if (name !== 0 && outcome.from)
                    {
                        writeSockaddr(host.writeMemory, name, outcome.from);
                        if (lengthPointer !== 0)
                        {
                            writeDword(lengthPointer, SOCKADDR_IN_SIZE);
                        }
                    }
                    // A datagram that did not fit reports the loss, and does so
                    // *after* the bytes that did fit have been handed over.
                    return outcome.truncated ? fail(WSAEMSGSIZE) : ok(outcome.value);
                });
            },
        },

        shutdown: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, how])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const outcome = registry.shutdown(socket, how);
                return outcome.error ? fail(outcome.error) : ok(0);
            },
        },

        getsockname: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, lengthPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                writeSockaddr(host.writeMemory, name, socket.local);
                if (lengthPointer !== 0)
                {
                    writeDword(lengthPointer, SOCKADDR_IN_SIZE);
                }
                return ok(0);
            },
        },

        getpeername: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, name, lengthPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                if (!socket.remote)
                {
                    return fail(WSAEINVAL);
                }
                writeSockaddr(host.writeMemory, name, socket.remote);
                if (lengthPointer !== 0)
                {
                    writeDword(lengthPointer, SOCKADDR_IN_SIZE);
                }
                return ok(0);
            },
        },

        setsockopt: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, , option, value, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                registry.writeOption(socket, option,
                    value !== 0 && length >= 4 ? readDword(value) : 0);
                return ok(0);
            },
        },

        getsockopt: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, level, option, value, lengthPointer])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                if (value === 0)
                {
                    return fail(WSAEFAULT);
                }
                const answer = level === SOL_SOCKET && option === SO_TYPE
                    ? socket.type
                    : registry.readOption(socket, option);
                writeDword(value, answer);
                if (lengthPointer !== 0)
                {
                    writeDword(lengthPointer, 4);
                }
                return ok(0);
            },
        },

        ioctlsocket: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, command, argument])=>ioctl(handle, command, argument),
        },

        /**
         * int WSAIoctl(SOCKET s, DWORD dwIoControlCode, LPVOID lpvInBuffer,
         *              DWORD cbInBuffer, LPVOID lpvOutBuffer, DWORD cbOutBuffer,
         *              LPDWORD lpcbBytesReturned, LPWSAOVERLAPPED lpOverlapped,
         *              LPWSAOVERLAPPED_COMPLETION_ROUTINE lpCompletionRoutine)
         *
         * The two commands ioctlsocket takes, in the buffered form: FIONBIO
         * reads its flag from the input buffer, FIONREAD writes its count to
         * the output one. The extension-function lookup is refused as not
         * supported, which is what a stack without those extensions says and
         * what sends a program to the plain calls it also has.
         */
        WSAIoctl: {
            argBytes: 36,
            /** @param {number[]} args */
            handler: ([handle, command, input, , output, outputSize, returned])=>{
                if (!socketOf(handle))
                {
                    return fail(WSAENOTSOCK);
                }
                if ((command >>> 0) === SIO_GET_EXTENSION_FUNCTION_POINTER)
                {
                    return fail(WSAEOPNOTSUPP);
                }
                if ((command >>> 0) === FIONBIO)
                {
                    return ioctl(handle, command, input);
                }
                if ((command >>> 0) === FIONREAD)
                {
                    if ((outputSize >>> 0) < 4)
                    {
                        return fail(WSAEFAULT);
                    }
                    const result = ioctl(handle, command, output);
                    if (result === 0 && returned !== 0)
                    {
                        writeDword(returned, 4);
                    }
                    return result;
                }
                return fail(WSAEINVAL);
            },
        },


        select: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, readPointer, writePointer, exceptPointer, timeout])=>{
                const gather3 = (/** @type {number} */ pointer)=>{
                    const handles = readFdSet(pointer);
                    return handles.map(socketOf);
                };
                const read = gather3(readPointer);
                const write = gather3(writePointer);
                const except = gather3(exceptPointer);
                if ([...read, ...write, ...except].some(socket=>!socket))
                {
                    return fail(WSAENOTSOCK);
                }

                const answer = ()=>{
                    const ready = registry.poll(read, write, except);
                    if (!writeFdSet(readPointer, ready.read)
                        || !writeFdSet(writePointer, ready.write)
                        || !writeFdSet(exceptPointer, ready.except))
                    {
                        return fail(WSAEFAULT);
                    }
                    return ok(ready.read.length + ready.write.length + ready.except.length);
                };

                const ready = registry.poll(read, write, except);
                const total = ready.read.length + ready.write.length + ready.except.length;
                if (total > 0)
                {
                    return answer();
                }

                // A timeval of NULL means wait forever; anything else, including
                // a zero timeout, is a poll that has already been answered.
                if (timeout !== 0)
                {
                    const seconds = readDword(timeout);
                    const micro = readDword((timeout >>> 0) + 4);
                    const milliseconds = seconds * 1000 + Math.floor(micro / 1000);
                    if (milliseconds === 0)
                    {
                        return answer();
                    }
                    return registry.anyReadableSoon(read, milliseconds).then(answer);
                }
                return registry.anyReadableSoon(read, null).then(answer);
            },
        },

        __WSAFDIsSet: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, pointer])=>
                readFdSet(pointer).includes(handle >>> 0) ? 1 : 0,
        },

        htons: { argBytes: 4, handler: (/** @type {number[]} */ [value])=>swap16(value) },
        ntohs: { argBytes: 4, handler: (/** @type {number[]} */ [value])=>swap16(value) },
        htonl: { argBytes: 4, handler: (/** @type {number[]} */ [value])=>swap32(value) },
        ntohl: { argBytes: 4, handler: (/** @type {number[]} */ [value])=>swap32(value) },

        inet_addr: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                if (pointer === 0)
                {
                    return INADDR_NONE;
                }
                const host32 = parseAddress(host.readCString(pointer >>> 0, 64));
                // The answer is in network order, because it goes straight into
                // a sockaddr without passing through htonl.
                return host32 === INADDR_NONE ? INADDR_NONE : swap32(host32);
            },
        },

        inet_ntoa: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([value])=>{
                const buffer = staticBuffer('inet_ntoa', 16);
                host.writeMemory(buffer, latin1(formatAddress(swap32(value))));
                return buffer >>> 0;
            },
        },

        gethostname: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, length])=>{
                if (buffer === 0 || length < HOSTNAME.length + 1)
                {
                    return fail(WSAEFAULT);
                }
                host.writeMemory(buffer >>> 0, latin1(HOSTNAME));
                return ok(0);
            },
        },

        /**
         * Resolution.
         *
         * The names this host can answer for itself -- its own, localhost, and
         * anything already written as an address -- are answered here and
         * without a round trip. Anything else is the transport's, and only if it
         * has a resolver at all: without one the call fails with
         * WSAHOST_NOT_FOUND rather than being pointed at the loopback, because a
         * program told a name resolved will connect to it and fail somewhere
         * further away with less to go on.
         */
        gethostbyname: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>{
                const name = pointer === 0 ? HOSTNAME : host.readCString(pointer >>> 0, 256);
                const literal = parseAddress(name);
                const known = name === HOSTNAME || name === 'localhost';
                if (literal !== INADDR_NONE || known)
                {
                    return writeHostent(
                        name, literal === INADDR_NONE ? INADDR_LOOPBACK : literal);
                }
                const asked = registry.resolve(name);
                if (!asked)
                {
                    return fail(WSAHOST_NOT_FOUND, 0);
                }
                return asked.then((/** @type {number[]} */ found)=>found.length === 0
                    ? fail(WSAHOST_NOT_FOUND, 0)
                    : writeHostent(name, found[0]));
            },
        },

        /**
         * The overlapped pair.
         *
         * Everything the completion would need is taken now, and the completion
         * itself has nowhere to go: posting one needs a completion port, and
         * there is no CreateIoCompletionPort here yet. So an operation that
         * cannot finish immediately is recorded and reported as pending, and
         * the out-parameters are deliberately left alone -- on the pending path
         * the count belongs to the completion packet, and writing it here is
         * what makes a program read a byte count for data that has not arrived.
         *
         * ponytail: pending operations accumulate on the socket with no port to
         * drain them. Wire them to CreateIoCompletionPort when it lands.
         */
        WSARecv: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, buffers, count, received, flags, overlapped])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const taken = readBuffers(buffers, count >>> 0);
                const outcome = registry.receive(socket, totalOf(taken));
                if (!outcome.error)
                {
                    scatter(taken, outcome.bytes);
                    if (received !== 0)
                    {
                        writeDword(received, outcome.value);
                    }
                    if (flags !== 0)
                    {
                        writeDword(flags, 0);
                    }
                    return ok(0);
                }
                if (outcome.error !== WSAEWOULDBLOCK)
                {
                    return fail(outcome.error);
                }
                if (overlapped !== 0)
                {
                    socket.pending.push({ kind: 'recv', overlapped, buffers: taken });
                    return fail(WSA_IO_PENDING);
                }
                if (socket.nonBlocking)
                {
                    return fail(WSAEWOULDBLOCK);
                }
                return until(socket, ()=>registry.receive(socket, totalOf(taken)))
                    .then(later=>{
                        if (later.error)
                        {
                            return fail(later.error);
                        }
                        scatter(taken, later.bytes);
                        if (received !== 0)
                        {
                            writeDword(received, later.value);
                        }
                        if (flags !== 0)
                        {
                            writeDword(flags, 0);
                        }
                        return ok(0);
                    });
            },
        },

        WSASend: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, buffers, count, sent])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK);
                }
                const taken = readBuffers(buffers, count >>> 0);
                const outcome = registry.send(socket, gather(taken));
                if (outcome.error)
                {
                    return fail(outcome.error);
                }
                if (sent !== 0)
                {
                    writeDword(sent, outcome.value);
                }
                return ok(0);
            },
        },
    };

    /** The extensions, which a program reaches by name through GetProcAddress. */
    const extensions = {
        AcceptEx: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([listenHandle, acceptHandle])=>{
                const listener = socketOf(listenHandle);
                const accepting = socketOf(acceptHandle);
                if (!listener || !accepting)
                {
                    return fail(WSAENOTSOCK, 0);
                }
                const outcome = registry.accept(listener);
                if (outcome.error)
                {
                    return fail(outcome.error === WSAEWOULDBLOCK
                        ? WSA_IO_PENDING : outcome.error, 0);
                }
                // The caller supplied the socket the connection is to arrive on,
                // so what accept produced is folded onto it rather than handed
                // back: AcceptEx has no return value that could carry a handle.
                const ready = registry.get(outcome.value);
                accepting.local = ready.local;
                accepting.remote = ready.remote;
                accepting.connected = true;
                accepting.peer = ready.peer;
                if (ready.peer)
                {
                    ready.peer.peer = accepting;
                }
                accepting.rx = ready.rx;
                // Detached before it is closed. Closing a stream socket tells
                // its peer the connection is finished, and this one still names
                // the client -- so leaving it attached would greet a client with
                // its own connection hanging up the instant it was accepted.
                ready.peer = null;
                registry.close(ready);
                return 1;
            },
        },

        GetAcceptExSockaddrs: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([, , , , , , localOut, remoteOut])=>{
                // The addresses live in the buffer AcceptEx was given, which we
                // never wrote into, so there is nothing honest to report here.
                if (localOut !== 0)
                {
                    writeDword(localOut, 0);
                }
                if (remoteOut !== 0)
                {
                    writeDword(remoteOut, 0);
                }
                return 0;
            },
        },

        ConnectEx: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, name, length])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK, 0);
                }
                if (length < SOCKADDR_IN_SIZE)
                {
                    return fail(WSAEFAULT, 0);
                }
                const address = readSockaddr(host.readMemory, name);
                if (!address)
                {
                    return fail(WSAEFAULT, 0);
                }
                const settle = (/** @type {any} */ outcome)=>
                    outcome.error ? fail(outcome.error, 0) : 1;
                const outcome = registry.connect(socket, address);
                return outcome instanceof Promise ? outcome.then(settle) : settle(outcome);
            },
        },

        DisconnectEx: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const socket = socketOf(handle);
                if (!socket)
                {
                    return fail(WSAENOTSOCK, 0);
                }
                registry.shutdown(socket, 2);
                return 1;
            },
        },
    };

    /**
     * The ordinals that actually resolve.
     *
     * The tables in constants.js record what each number *is*, including entries
     * this does not implement -- that is reference data and worth keeping. What
     * a module may export is the intersection with what exists, computed rather
     * than maintained: an ordinal exported to a guest and pointing at nothing is
     * a call that binds and then jumps into nowhere, with no name anywhere in
     * the import table to say what it was.
     *
     * @param {Record<number, string>} all
     */
    const resolvable = all=>Object.freeze(Object.fromEntries(
        Object.entries(all).filter(([, name])=>name in table)));

    return {
        /** wsock32 and ws2_32 both export these, over one registry. */
        sockets: table,
        /** mswsock's, reached by name rather than through an import table. */
        extensions,
        /** Which ordinal is which name, for whoever synthesises the module. */
        ordinals: {
            wsock32: resolvable(WSOCK32_ORDINALS),
            ws2_32: resolvable(WS2_32_ORDINALS),
        },
        diagnostics: ()=>({ started, ...registry.diagnostics() }),
    };
}
