/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The origin's file system as a test makes it, in memory and in its shape: a
 * directory's handles made or refused as the browser does, a synchronous
 * handle the file's exclusive lock until it is closed, `getFile` a Blob of the
 * bytes as they are, and an origin of a given room, past which a write is
 * refused with the browser's `QuotaExceededError`.
 */

/**
 * @typedef {{ kind: 'file', data: Uint8Array, locked: boolean, modified: number }} FileNode
 * @typedef {{ kind: 'directory', children: Map<string, FileNode | DirectoryNode> }} DirectoryNode
 */

/** @returns {DirectoryNode} */
const directoryNode = ()=>({ kind: 'directory', children: new Map() });

/**
 * @param {{ quota?: number }} [options]  `quota`: the bytes every file of the
 *     origin may hold together
 */
export function fakeOpfs({ quota = Infinity } = {}){
    const top = directoryNode();
    let clock = 0;

    /** Every file's bytes added up. @param {DirectoryNode} node @returns {number} */
    const used = (node = top)=>{
        let sum = 0;
        for (const child of node.children.values())
        {
            sum += child.kind === 'file' ? child.data.length : used(child);
        }
        return sum;
    };

    /** @param {FileNode} node @param {string} name */
    const access = (node, name)=>{
        let closed = false;
        const live = ()=>{
            if (closed)
            {
                throw new DOMException(`"${name}" is closed`, 'InvalidStateError');
            }
        };
        return {
            /** @param {Uint8Array} into @param {{ at?: number }} [where] */
            read(into, where){
                live();
                const start = Math.min(where?.at ?? 0, node.data.length);
                const part = node.data.subarray(start, Math.min(start + into.length,
                    node.data.length));
                into.set(part);
                return part.length;
            },
            /** @param {Uint8Array} from @param {{ at?: number }} [where] */
            write(from, where){
                live();
                const at = where?.at ?? 0;
                const end = at + from.length;
                if (end > node.data.length)
                {
                    if (used() + end - node.data.length > quota)
                    {
                        throw new DOMException('the origin is out of room', 'QuotaExceededError');
                    }
                    const grown = new Uint8Array(end);
                    grown.set(node.data);
                    node.data = grown;
                }
                node.data.set(from, at);
                node.modified = ++clock;
                return from.length;
            },
            /** @param {number} size */
            truncate(size){
                live();
                const resized = new Uint8Array(size);
                resized.set(node.data.subarray(0, Math.min(size, node.data.length)));
                node.data = resized;
            },
            getSize(){
                live();
                return node.data.length;
            },
            flush(){
                live();
            },
            close(){
                closed = true;
                node.locked = false;
            },
        };
    };

    /** @param {FileNode} node @param {string} name */
    const file = (node, name)=>({
        kind: 'file',
        getFile: async()=>new File(/** @type {BlobPart[]} */ ([node.data.slice()]), name,
            { lastModified: node.modified }),
        async createSyncAccessHandle(){
            if (node.locked)
            {
                throw new DOMException(`"${name}" is in use`, 'NoModificationAllowedError');
            }
            node.locked = true;
            return access(node, name);
        },
    });

    /** @param {DirectoryNode} node @returns {any} */
    const directory = node=>({
        kind: 'directory',
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getDirectoryHandle(name, options){
            const found = node.children.get(name);
            if (found?.kind === 'file')
            {
                throw new DOMException(`"${name}" is a file`, 'TypeMismatchError');
            }
            if (!found && !options?.create)
            {
                throw new DOMException(`"${name}" does not exist`, 'NotFoundError');
            }
            const child = found ?? directoryNode();
            node.children.set(name, child);
            return directory(child);
        },
        /** @param {string} name @param {{ create?: boolean }} [options] */
        async getFileHandle(name, options){
            const found = node.children.get(name);
            if (found?.kind === 'directory')
            {
                throw new DOMException(`"${name}" is a directory`, 'TypeMismatchError');
            }
            if (!found && !options?.create)
            {
                throw new DOMException(`"${name}" does not exist`, 'NotFoundError');
            }
            /** @type {FileNode} */
            const child = found ?? { kind: 'file', data: new Uint8Array(0), locked: false,
                modified: ++clock };
            node.children.set(name, child);
            return file(child, name);
        },
        /** @param {string} name @param {{ recursive?: boolean }} [options] */
        async removeEntry(name, options){
            const child = node.children.get(name);
            if (!child)
            {
                throw new DOMException(`"${name}" does not exist`, 'NotFoundError');
            }
            if (child.kind === 'directory' && child.children.size > 0 && !options?.recursive)
            {
                throw new DOMException(`"${name}" is not empty`, 'InvalidModificationError');
            }
            if (child.kind === 'file' && child.locked)
            {
                throw new DOMException(`"${name}" is in use`, 'NoModificationAllowedError');
            }
            node.children.delete(name);
        },
        async *entries(){
            for (const [name, child] of [...node.children])
            {
                yield /** @type {[string, any]} */ ([name, child.kind === 'directory'
                    ? directory(child) : file(child, name)]);
            }
        },
    });

    /**
     * A file's node by its path from the root (`/` between names), for a test
     * to look at or cut; undefined where there is none.
     *
     * @param {string} path
     * @returns {FileNode | undefined}
     */
    const node = path=>{
        /** @type {FileNode | DirectoryNode | undefined} */
        let at = top;
        for (const name of path.split('/'))
        {
            at = at?.kind === 'directory' ? at.children.get(name) : undefined;
        }
        return at?.kind === 'file' ? at : undefined;
    };

    /**
     * Puts a file at the root, as an older build left it.
     *
     * @param {string} name @param {Uint8Array} data
     */
    const put = (name, data)=>{
        top.children.set(name, { kind: 'file', data, locked: false, modified: ++clock });
    };

    /** The names at the root, and under a directory there. @param {string} [path] */
    const names = (path = '')=>{
        /** @type {FileNode | DirectoryNode | undefined} */
        let at = top;
        for (const name of path.split('/').filter(Boolean))
        {
            at = at?.kind === 'directory' ? at.children.get(name) : undefined;
        }
        return at?.kind === 'directory' ? [...at.children.keys()].sort() : [];
    };

    return { root: directory(top), node, put, names, used: ()=>used() };
}
