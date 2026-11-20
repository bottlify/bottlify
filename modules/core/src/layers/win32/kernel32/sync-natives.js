/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The native calls over kernel32's events, mutants, semaphores and timers,
 * which ntdll publishes.
 *
 * One object, two front doors: an event NtCreateEvent makes is the object
 * CreateEvent makes, found by the same name and waited on by the same wait.
 * What differs is only how the call is spelt. A native create names its object
 * by an OBJECT_ATTRIBUTES path (`object-attributes.js`) and opens an existing
 * one only where OBJ_OPENIF asks (STATUS_OBJECT_NAME_EXISTS), refusing it with
 * STATUS_OBJECT_NAME_COLLISION otherwise; a native set or release hands back
 * the state it found; a failure is a status and the thread's last error is
 * left alone, as the kernel leaves it.
 */

import { OBJ_INHERIT, OBJ_OPENIF, nameToWalk, readObjectAttributes } from './object-attributes.js';
import { TAKEN } from './named-objects.js';
import { KEYEDEVENT_WAIT, KEYEDEVENT_WAKE, MODIFY_STATE, QUERY_STATE, allows,
    grantedAccess } from './access.js';
import { dueInMs, readLargeInteger, FILETIME_EPOCH_MS } from './due-time.js';
import { STATUS } from '../ntdll/status.js';
import { wholeAddress } from '../common/pointers.js';

/** EVENT_TYPE: a manual-reset event, an auto-reset one. */
const NOTIFICATION_EVENT = 0;
const SYNCHRONIZATION_EVENT = 1;
/** TIMER_TYPE, the same two. */
const NOTIFICATION_TIMER = 0;
const SYNCHRONIZATION_TIMER = 1;

/** A keyed event's key is even: its low bit is the system's own. */
const STATUS_INVALID_PARAMETER_1 = 0xc00000ef;

/** The basic information class of each query, and its record's size. */
const BASIC_INFORMATION = 0;
const EVENT_BASIC_SIZE = 8;
const MUTANT_BASIC_SIZE = 8;
const SEMAPHORE_BASIC_SIZE = 8;
const TIMER_BASIC_SIZE = 12;

/**
 * @typedef {Object} SyncNativesHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {any} kernel
 * @property {{ mutex: Function, event: Function, semaphore: Function, timer: Function,
 *     keyedEvent: Function }} creates
 *     kernel32's creates over a name already read (`threading.js`)
 * @property {(name: string | null, kind: string) => any} existing
 * @property {(given: import('./object-attributes.js').ObjectAttributes, kind: string)
 *     => string | number} keyOf  where a native name is kept, or the status refusing it
 *     (`named-objects.js`)
 * @property {(found: any) => void} reference  a named object's count, for a handle opened on it
 * @property {(handle: number, kind?: string) => any} object
 * @property {() => any} currentThread
 * @property {() => any} park  stops the running thread; what its call answers until woken
 * @property {(thread: any, routine: number, args: number[]) => void} [queueApc]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {SyncNativesHost} host
 */
export function createSyncNatives(host){
    const { kernel } = host;

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(wholeAddress(address), bytes);
    };
    /** @param {number} address @param {number} value */
    const writeDwordIf = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            writeDword(address, value);
        }
    };
    /** @param {number} address @param {number} value */
    const writeByteIf = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            host.writeMemory(wholeAddress(address), new Uint8Array([value & 0xff]));
        }
    };

    /**
     * The object a handle names, as the status a native call answers where it
     * names none of that kind or lacks the right.
     *
     * @param {number} handle @param {string} kind @param {number} [right]
     * @returns {any | number}
     */
    const target = (handle, kind, right)=>{
        const found = host.object(handle >>> 0, kind);
        if (!found)
        {
            return host.object(handle >>> 0) ? STATUS.OBJECT_TYPE_MISMATCH : STATUS.INVALID_HANDLE;
        }
        if (right !== undefined && !allows(kernel.handles.access?.(handle >>> 0) ?? null, right))
        {
            return STATUS.ACCESS_DENIED;
        }
        return found;
    };

    /**
     * A native create: the name its attributes give read, an object its name
     * holds already answered as OBJ_OPENIF says, and `make` called for the
     * handle.
     *
     * @param {string} kind @param {number} out @param {number} attributes
     * @param {(name: string | null, sd: number, inherit: boolean) => number} make
     */
    const create = (kind, out, attributes, make)=>{
        if ((out >>> 0) === 0)
        {
            return STATUS.ACCESS_VIOLATION;
        }
        // The handle's place is written first: a call that cannot answer
        // makes nothing.
        writeDword(out, 0);
        const given = readObjectAttributes(host.readMemory, attributes);
        const walked = nameToWalk(given, false);
        if ('status' in walked)
        {
            return walked.status;
        }
        let name = null;
        if (given !== null && walked.name !== null)
        {
            const key = host.keyOf(given, kind);
            if (typeof key === 'number')
            {
                return key;
            }
            name = key;
        }
        const found = host.existing(name, kind);
        if (found === TAKEN)
        {
            return STATUS.OBJECT_TYPE_MISMATCH;
        }
        if (found && (given?.attributes ?? 0) & OBJ_OPENIF)
        {
            // Not `make`: a create's own arguments do not apply to an object
            // that already was, and the status says it was.
            host.reference(found);
            writeDword(out, kernel.handles.open(kind, found));
            return STATUS.OBJECT_NAME_EXISTS;
        }
        if (found)
        {
            return STATUS.OBJECT_NAME_COLLISION;
        }
        const flags = given?.attributes ?? 0;
        const handle = make(name, given?.security ?? 0, (flags & OBJ_INHERIT) !== 0);
        if (handle === 0)
        {
            return STATUS.INVALID_PARAMETER;
        }
        writeDword(out, handle);
        return STATUS.SUCCESS;
    };

    /**
     * A native open by name.
     *
     * @param {string} kind @param {number} out @param {number} access @param {number} attributes
     */
    const open = (kind, out, access, attributes)=>{
        if ((out >>> 0) === 0)
        {
            return STATUS.ACCESS_VIOLATION;
        }
        writeDword(out, 0);
        const given = readObjectAttributes(host.readMemory, attributes);
        const walked = nameToWalk(given, true);
        if ('status' in walked || given === null)
        {
            return 'status' in walked ? walked.status : STATUS.INVALID_PARAMETER;
        }
        const name = host.keyOf(given, kind);
        if (typeof name === 'number')
        {
            return name;
        }
        const found = host.existing(name, kind);
        if (found === TAKEN)
        {
            return STATUS.OBJECT_TYPE_MISMATCH;
        }
        if (!found)
        {
            return STATUS.OBJECT_NAME_NOT_FOUND;
        }
        const granted = grantedAccess(kind, access);
        if ('error' in granted)
        {
            return STATUS.ACCESS_DENIED;
        }
        host.reference(found);
        writeDword(out, kernel.handles.open(kind, found, granted.granted));
        return STATUS.SUCCESS;
    };

    /**
     * A query of a basic-information class: the record written where it fits.
     *
     * @param {number} kind @param {number} size @param {number} buffer @param {number} length
     * @param {number} returned @param {() => Uint8Array} record
     */
    const query = (kind, size, buffer, length, returned, record)=>{
        if (kind !== BASIC_INFORMATION)
        {
            return STATUS.INVALID_INFO_CLASS;
        }
        if ((length >>> 0) !== size)
        {
            return STATUS.INFO_LENGTH_MISMATCH;
        }
        if ((buffer >>> 0) === 0)
        {
            return STATUS.ACCESS_VIOLATION;
        }
        host.writeMemory(wholeAddress(buffer), record());
        writeDwordIf(returned, size);
        return STATUS.SUCCESS;
    };

    /**
     * An event's state changed by `change`, the state it had handed back.
     *
     * @param {number} handle @param {number} previous @param {(event: any) => void} change
     */
    const eventChange = (handle, previous, change)=>{
        const event = target(handle, 'event', MODIFY_STATE);
        if (typeof event === 'number')
        {
            return event;
        }
        const was = event.signalled ? 1 : 0;
        change(event);
        writeDwordIf(previous, was);
        return STATUS.SUCCESS;
    };

    /**
     * RTL_RWLOCK, by address: its active count (positive, holders sharing it;
     * negative, the one holder's exclusive recursion), its owner, and the
     * threads queued for each kind of hold. The structure in guest memory is
     * the caller's to own and is not read: what it holds is kept here, as the
     * lock it is.
     *
     * @type {Map<number, { active: number, owner: any, shared: any[], exclusive: any[] }>}
     */
    const resources = new Map();
    /** @param {number} address */
    const resourceAt = address=>{
        let found = resources.get(address >>> 0);
        if (!found)
        {
            found = { active: 0, owner: null, shared: [], exclusive: [] };
            resources.set(address >>> 0, found);
        }
        return found;
    };
    /**
     * A thread queued on a resource, parked until a release hands it the hold:
     * the acquire then answers TRUE.
     *
     * @param {any[]} queue @param {string} reason
     */
    const queueFor = (queue, reason)=>{
        const thread = host.currentThread();
        queue.push(thread);
        kernel.block(thread, reason);
        return host.park();
    };
    /**
     * A resource nobody holds handed on: to the first exclusive waiter, or
     * else to every shared one.
     *
     * @param {{ active: number, owner: any, shared: any[], exclusive: any[] }} resource
     */
    const handOn = resource=>{
        while (resource.active === 0 && resource.exclusive.length > 0)
        {
            const next = resource.exclusive.shift();
            if (kernel.wake(next, 1))
            {
                resource.active = -1;
                resource.owner = next;
            }
        }
        while (resource.active >= 0 && resource.shared.length > 0)
        {
            if (kernel.wake(resource.shared.shift(), 1))
            {
                resource.active++;
            }
        }
    };

    /**
     * The keyed event a NULL handle names: the one the system makes at boot
     * (\KernelObjects\CritSecOutOfMemoryEvent) for every process to use.
     *
     * @type {any}
     */
    let systemKeyed = null;
    /**
     * Each thread parked on a keyed event, and the queue it waits in: a timed
     * wait that ran out leaves it.
     *
     * @type {Map<any, any[]>}
     */
    const pairing = new Map();
    let watchingTimeouts = false;

    /**
     * NtWaitForKeyedEvent and NtReleaseKeyedEvent, the one rendezvous seen
     * from either side: a thread of the other side already parked on the key
     * is woken and both go on; otherwise the caller parks until one comes, or
     * its time-out runs out. A thread an APC took out of its wait is passed
     * over when its entry is found.
     *
     * @param {number} handle @param {number} key @param {number} alertable @param {number} timeout
     * @param {'waiting' | 'releasing'} side @param {number} right
     */
    const rendezvous = (handle, key, alertable, timeout, side, right)=>{
        if ((key & 1) !== 0)
        {
            return STATUS_INVALID_PARAMETER_1;
        }
        let keyed;
        if ((handle >>> 0) === 0)
        {
            systemKeyed ??= Object.assign(kernel.createEvent({ manualReset: true,
                signalled: true, name: 'CritSecOutOfMemoryEvent' }),
            { keyed: { waiting: [], releasing: [] } });
            keyed = systemKeyed;
        }
        else
        {
            keyed = target(handle, 'keyedevent', right);
            if (typeof keyed === 'number')
            {
                return keyed;
            }
        }
        const other = keyed.keyed[side === 'waiting' ? 'releasing' : 'waiting'];
        for (let at = other.findIndex((/** @type {any} */ entry)=>entry.key === key >>> 0);
            at >= 0; at = other.findIndex((/** @type {any} */ entry)=>entry.key === key >>> 0))
        {
            const [entry] = other.splice(at, 1);
            pairing.delete(entry.thread);
            if (kernel.wake(entry.thread, STATUS.SUCCESS))
            {
                return STATUS.SUCCESS;
            }
        }
        /** @type {number | undefined} */
        let deadline;
        if ((timeout >>> 0) !== 0)
        {
            const ms = dueInMs(readLargeInteger(host.readMemory, timeout),
                kernel.clock.wallClock());
            if (ms <= 0)
            {
                return STATUS.TIMEOUT;
            }
            deadline = kernel.clock.virtualTime() + ms;
        }
        if (!watchingTimeouts)
        {
            watchingTimeouts = true;
            kernel.onTimeout((/** @type {any} */ thread)=>{
                const queue = pairing.get(thread);
                pairing.delete(thread);
                const at = queue?.findIndex(entry=>entry.thread === thread) ?? -1;
                if (at >= 0)
                {
                    queue?.splice(at, 1);
                }
            });
        }
        const thread = host.currentThread();
        const queue = keyed.keyed[side];
        queue.push({ thread, key: key >>> 0 });
        pairing.set(thread, queue);
        const park = ()=>{
            kernel.block(thread, `keyed event ${side === 'waiting' ? 'wait' : 'release'} `
                + `0x${(key >>> 0).toString(16)}`, deadline === undefined ? undefined
                : { deadline, result: STATUS.TIMEOUT });
            return host.park();
        };
        return (alertable & 0xff) !== 0 ? kernel.alertably(thread, park) : park();
    };

    return {
        /** void RtlInitializeResource(PRTL_RWLOCK) */
        RtlInitializeResource: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([address])=>{
                resources.set(address >>> 0, { active: 0, owner: null, shared: [], exclusive: [] });
                return 0;
            },
        },
        /** void RtlDeleteResource(PRTL_RWLOCK) */
        RtlDeleteResource: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([address])=>{
                resources.delete(address >>> 0);
                return 0;
            },
        },
        /**
         * BOOLEAN RtlAcquireResourceExclusive(PRTL_RWLOCK, BOOLEAN Wait)
         *
         * Taken where nobody holds it, or again by the thread holding it so;
         * otherwise FALSE, or with Wait a park until a release hands it over.
         */
        RtlAcquireResourceExclusive: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([address, wait])=>{
                const resource = resourceAt(address);
                const thread = host.currentThread();
                if (resource.active === 0)
                {
                    resource.active = -1;
                    resource.owner = thread;
                    return 1;
                }
                if (resource.active < 0 && resource.owner === thread)
                {
                    resource.active--;
                    return 1;
                }
                return (wait & 0xff) === 0 ? 0
                    : queueFor(resource.exclusive, 'RtlAcquireResourceExclusive');
            },
        },
        /**
         * BOOLEAN RtlAcquireResourceShared(PRTL_RWLOCK, BOOLEAN Wait)
         *
         * Shared beside other sharers; the exclusive holder taking it shared
         * holds it once more exclusively.
         */
        RtlAcquireResourceShared: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([address, wait])=>{
                const resource = resourceAt(address);
                if (resource.active >= 0)
                {
                    resource.active++;
                    return 1;
                }
                if (resource.owner === host.currentThread())
                {
                    resource.active--;
                    return 1;
                }
                return (wait & 0xff) === 0 ? 0
                    : queueFor(resource.shared, 'RtlAcquireResourceShared');
            },
        },
        /** void RtlReleaseResource(PRTL_RWLOCK): one hold given up, the last one handed on. */
        RtlReleaseResource: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([address])=>{
                const resource = resourceAt(address);
                if (resource.active > 0)
                {
                    resource.active--;
                }
                else if (resource.active < 0 && ++resource.active === 0)
                {
                    resource.owner = null;
                }
                handOn(resource);
                return 0;
            },
        },

        /**
         * NTSTATUS NtCreateEvent(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
         *                        EVENT_TYPE EventType, BOOLEAN InitialState)
         */
        NtCreateEvent: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([out, , attributes, type, initial])=>{
                if (type !== NOTIFICATION_EVENT && type !== SYNCHRONIZATION_EVENT)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                return create('event', out, attributes, (name, sd, inherit)=>host.creates.event(
                    name, type === NOTIFICATION_EVENT, (initial & 0xff) !== 0, sd, inherit));
            },
        },
        /** NTSTATUS NtOpenEvent(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES) */
        NtOpenEvent: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, access, attributes])=>open('event', out, access, attributes),
        },
        /** NTSTATUS NtSetEvent(HANDLE, PLONG PreviousState) */
        NtSetEvent: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, previous])=>eventChange(handle, previous,
                event=>kernel.setEvent(event)),
        },
        /** NTSTATUS NtResetEvent(HANDLE, PLONG PreviousState) */
        NtResetEvent: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, previous])=>eventChange(handle, previous,
                event=>kernel.resetEvent(event)),
        },
        /**
         * NTSTATUS NtSetEventBoostPriority(HANDLE): NtSetEvent, the thread it
         * releases run at once; this scheduler keeps no priorities to boost.
         */
        NtSetEventBoostPriority: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>eventChange(handle, 0, event=>kernel.setEvent(event)),
        },
        /** NTSTATUS NtClearEvent(HANDLE): NtResetEvent with no state handed back. */
        NtClearEvent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>eventChange(handle, 0, event=>kernel.resetEvent(event)),
        },
        /**
         * NTSTATUS NtPulseEvent(HANDLE, PLONG PreviousState): the waiters it can
         * release released, and the event left unsignalled.
         */
        NtPulseEvent: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, previous])=>eventChange(handle, previous, event=>{
                kernel.setEvent(event);
                kernel.resetEvent(event);
            }),
        },
        /**
         * NTSTATUS NtQueryEvent(HANDLE, EVENT_INFORMATION_CLASS, PVOID, ULONG, PULONG)
         *
         * EVENT_BASIC_INFORMATION: its type and whether it is signalled.
         */
        NtQueryEvent: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, kind, buffer, length, returned])=>{
                const event = target(handle, 'event', QUERY_STATE);
                if (typeof event === 'number')
                {
                    return event;
                }
                return query(kind, EVENT_BASIC_SIZE, buffer, length, returned, ()=>{
                    const record = new DataView(new ArrayBuffer(EVENT_BASIC_SIZE));
                    record.setUint32(0, event.manualReset ? NOTIFICATION_EVENT
                        : SYNCHRONIZATION_EVENT, true);
                    record.setUint32(4, event.signalled ? 1 : 0, true);
                    return new Uint8Array(record.buffer);
                });
            },
        },

        /**
         * NTSTATUS NtCreateMutant(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
         *                         BOOLEAN InitialOwner)
         */
        NtCreateMutant: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([out, , attributes, owner])=>create('mutex', out, attributes,
                (name, sd, inherit)=>host.creates.mutex(name, (owner & 0xff) !== 0, sd, inherit)),
        },
        /** NTSTATUS NtOpenMutant(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES) */
        NtOpenMutant: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, access, attributes])=>open('mutex', out, access, attributes),
        },
        /**
         * NTSTATUS NtReleaseMutant(HANDLE, PLONG PreviousCount)
         *
         * The count handed back is the mutant's signal state before the
         * release: 1 free, 0 owned once, -n owned n + 1 times.
         */
        NtReleaseMutant: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, previous])=>{
                const mutex = target(handle, 'mutex');
                if (typeof mutex === 'number')
                {
                    return mutex;
                }
                const count = mutex.owner === null ? 1 : 1 - mutex.recursion;
                if (!kernel.releaseMutex(mutex, host.currentThread()))
                {
                    return STATUS.MUTANT_NOT_OWNED;
                }
                writeDwordIf(previous, count);
                return STATUS.SUCCESS;
            },
        },
        /**
         * NTSTATUS NtQueryMutant(HANDLE, MUTANT_INFORMATION_CLASS, PVOID, ULONG, PULONG)
         *
         * MUTANT_BASIC_INFORMATION: CurrentCount (the signal state, as
         * NtReleaseMutant hands back), OwnedByCaller, AbandonedState.
         */
        NtQueryMutant: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, kind, buffer, length, returned])=>{
                const mutex = target(handle, 'mutex', QUERY_STATE);
                if (typeof mutex === 'number')
                {
                    return mutex;
                }
                return query(kind, MUTANT_BASIC_SIZE, buffer, length, returned, ()=>{
                    const record = new DataView(new ArrayBuffer(MUTANT_BASIC_SIZE));
                    record.setInt32(0, mutex.owner === null ? 1 : 1 - mutex.recursion, true);
                    record.setUint8(4, mutex.owner === host.currentThread() ? 1 : 0);
                    record.setUint8(5, mutex.abandoned ? 1 : 0);
                    return new Uint8Array(record.buffer);
                });
            },
        },

        /**
         * NTSTATUS NtCreateSemaphore(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
         *                            LONG InitialCount, LONG MaximumCount)
         */
        NtCreateSemaphore: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([out, , attributes, initial, maximum])=>{
                if ((maximum | 0) <= 0 || (initial | 0) < 0 || (initial | 0) > (maximum | 0))
                {
                    return STATUS.INVALID_PARAMETER;
                }
                return create('semaphore', out, attributes, (name, sd, inherit)=>
                    host.creates.semaphore(name, initial | 0, maximum | 0, sd, inherit));
            },
        },
        /** NTSTATUS NtOpenSemaphore(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES) */
        NtOpenSemaphore: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, access, attributes])=>open('semaphore', out, access, attributes),
        },
        /**
         * NTSTATUS NtReleaseSemaphore(HANDLE, ULONG ReleaseCount, PULONG PreviousCount)
         *
         * Past the maximum nothing is released, as ReleaseSemaphore does.
         */
        NtReleaseSemaphore: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, count, previous])=>{
                const semaphore = target(handle, 'semaphore', MODIFY_STATE);
                if (typeof semaphore === 'number')
                {
                    return semaphore;
                }
                if ((count | 0) <= 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                if (semaphore.count + (count | 0) > semaphore.maximum)
                {
                    return STATUS.SEMAPHORE_LIMIT_EXCEEDED;
                }
                writeDwordIf(previous, kernel.releaseSemaphore(semaphore, count | 0));
                return STATUS.SUCCESS;
            },
        },
        /**
         * NTSTATUS NtQuerySemaphore(HANDLE, SEMAPHORE_INFORMATION_CLASS, PVOID, ULONG, PULONG)
         *
         * SEMAPHORE_BASIC_INFORMATION: CurrentCount, MaximumCount.
         */
        NtQuerySemaphore: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, kind, buffer, length, returned])=>{
                const semaphore = target(handle, 'semaphore', QUERY_STATE);
                if (typeof semaphore === 'number')
                {
                    return semaphore;
                }
                return query(kind, SEMAPHORE_BASIC_SIZE, buffer, length, returned, ()=>{
                    const record = new DataView(new ArrayBuffer(SEMAPHORE_BASIC_SIZE));
                    record.setInt32(0, semaphore.count, true);
                    record.setInt32(4, semaphore.maximum, true);
                    return new Uint8Array(record.buffer);
                });
            },
        },

        /**
         * NTSTATUS NtCreateKeyedEvent(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, ULONG Flags)
         *
         * The handle carries the rights asked for: KEYEDEVENT_WAIT to wait on
         * a key, KEYEDEVENT_WAKE to release one, SYNCHRONIZE to wait on the
         * handle itself (which is always signalled).
         */
        NtCreateKeyedEvent: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([out, access, attributes, flags])=>{
                if ((flags >>> 0) !== 0)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                const granted = grantedAccess('keyedevent', access);
                if ('error' in granted)
                {
                    return STATUS.ACCESS_DENIED;
                }
                return create('keyedevent', out, attributes, (name, sd, inherit)=>
                    host.creates.keyedEvent(name, sd, inherit, granted.granted));
            },
        },
        /** NTSTATUS NtOpenKeyedEvent(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES) */
        NtOpenKeyedEvent: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, access, attributes])=>open('keyedevent', out, access, attributes),
        },
        /**
         * NTSTATUS NtWaitForKeyedEvent(HANDLE, PVOID Key, BOOLEAN Alertable,
         *                              PLARGE_INTEGER Timeout)
         *
         * Parks until a release names the same key, or answers at once where
         * one is already parked on it.
         */
        NtWaitForKeyedEvent: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, key, alertable, timeout])=>
                rendezvous(handle, key, alertable, timeout, 'waiting', KEYEDEVENT_WAIT),
        },
        /**
         * NTSTATUS NtReleaseKeyedEvent(HANDLE, PVOID Key, BOOLEAN Alertable,
         *                              PLARGE_INTEGER Timeout)
         *
         * Releases one thread waiting on the key, parking until one comes.
         */
        NtReleaseKeyedEvent: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([handle, key, alertable, timeout])=>
                rendezvous(handle, key, alertable, timeout, 'releasing', KEYEDEVENT_WAKE),
        },

        /**
         * NTSTATUS NtCreateTimer(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
         *                        TIMER_TYPE TimerType)
         */
        NtCreateTimer: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([out, , attributes, type])=>{
                if (type !== NOTIFICATION_TIMER && type !== SYNCHRONIZATION_TIMER)
                {
                    return STATUS.INVALID_PARAMETER;
                }
                return create('timer', out, attributes, (name, sd, inherit)=>
                    host.creates.timer(name, type === NOTIFICATION_TIMER, sd, inherit));
            },
        },
        /** NTSTATUS NtOpenTimer(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES) */
        NtOpenTimer: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, access, attributes])=>open('timer', out, access, attributes),
        },
        /**
         * NTSTATUS NtSetTimer(HANDLE, PLARGE_INTEGER DueTime,
         *   PTIMER_APC_ROUTINE, PVOID TimerContext, BOOLEAN ResumeTimer,
         *   LONG Period, PBOOLEAN PreviousState)
         *
         * SetWaitableTimer's arm, the state the timer had handed back. The
         * routine is queued to the thread that set the timer, as
         * SetWaitableTimer's completion routine is: (context, low, high) of the
         * moment it came due.
         */
        NtSetTimer: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, dueTime, routine, context, , period, previous])=>{
                const timer = target(handle, 'timer', MODIFY_STATE);
                if (typeof timer === 'number')
                {
                    return timer;
                }
                if ((dueTime >>> 0) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                if ((period | 0) < 0)
                {
                    return STATUS.INVALID_PARAMETER_MIX;
                }
                const was = timer.signalled ? 1 : 0;
                const due = kernel.clock.virtualTime() + dueInMs(
                    readLargeInteger(host.readMemory, dueTime), kernel.clock.wallClock());
                const thread = host.currentThread();
                const fired = (routine >>> 0) === 0 || !host.queueApc ? null : ()=>{
                    const filetime = BigInt(Math.floor(kernel.clock.wallClock()
                        + FILETIME_EPOCH_MS)) * 10000n;
                    host.queueApc?.(thread, routine >>> 0, [context >>> 0,
                        Number(filetime & 0xffffffffn), Number(filetime >> 32n & 0xffffffffn)]);
                };
                kernel.armTimer(timer, due, period | 0, fired);
                writeByteIf(previous, was);
                return STATUS.SUCCESS;
            },
        },
        /** NTSTATUS NtCancelTimer(HANDLE, PBOOLEAN CurrentState) */
        NtCancelTimer: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, current])=>{
                const timer = target(handle, 'timer', MODIFY_STATE);
                if (typeof timer === 'number')
                {
                    return timer;
                }
                kernel.cancelTimer(timer);
                writeByteIf(current, timer.signalled ? 1 : 0);
                return STATUS.SUCCESS;
            },
        },
        /**
         * NTSTATUS NtQueryTimer(HANDLE, TIMER_INFORMATION_CLASS, PVOID, ULONG, PULONG)
         *
         * TIMER_BASIC_INFORMATION: RemainingTime (hundreds of nanoseconds to
         * the due time; zero, or how long since, past it) and TimerState.
         */
        NtQueryTimer: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, kind, buffer, length, returned])=>{
                const timer = target(handle, 'timer', QUERY_STATE);
                if (typeof timer === 'number')
                {
                    return timer;
                }
                return query(kind, TIMER_BASIC_SIZE, buffer, length, returned, ()=>{
                    const record = new DataView(new ArrayBuffer(TIMER_BASIC_SIZE));
                    const left = timer.due === null ? 0
                        : Math.max(0, timer.due - kernel.clock.virtualTime());
                    record.setBigInt64(0, BigInt(Math.round(left * 10000)), true);
                    record.setUint8(8, timer.signalled ? 1 : 0);
                    return new Uint8Array(record.buffer);
                });
            },
        },
    };
}
