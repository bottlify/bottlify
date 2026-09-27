# Out-of-process COM

A class registered only under `LocalServer32` is served by an executable. When a program asks for
one with `CLSCTX_LOCAL_SERVER`, the object is made in the server's process, and the caller holds a
proxy to it. This page describes how that works here.

## Processes

Each process is a machine of its own, with its own memory, volume and hive. `createApp` keeps one
**class table** for the whole run, the way the service control manager is one table per machine
(`layers/win32/ole32/remote.js`, `createClassTable`). Every machine is built with
`{ table, process }` in its `com` option, and ole32 reaches the table through that.

`CoCreateInstance`/`CoGetClassObject` with `CLSCTX_LOCAL_SERVER` look in the table first. If no
process has registered the class, they start the class's server beside the caller: the command
line is the `LocalServer32` value followed by ` -Embedding`. The caller then waits until the
server calls `CoRegisterClassObject` for that CLSID. If the server exits without registering, the
answer is `CO_E_SERVER_EXEC_FAILURE`.

The server runs concurrently with every other process, in its own line of processes. A child it
starts and waits on, or an image it hands over to, runs the same way the page's own program does.
While it stands, the page's facade (input, picture, log) is bound to the server.

The registration flags behave as they do on Windows:

- `REGCLS_SINGLEUSE`: the object is handed to one client only.
- `REGCLS_MULTIPLEUSE`: the object is shared by every client.
- `REGCLS_SUSPENDED`: the object is hidden until `CoResumeClassObjects`.

`CoRevokeClassObject`, the last `CoUninitialize` and the end of the process all withdraw a
registration.

## Calls

What crosses between processes is a reference: the exporting process and the object's number in
its table. The receiving side builds a **proxy**, a host object whose vtable sends each call to
the exporter. There, a stub makes the call on the real object and sends back what the method
wrote.

The model is the single-threaded apartment:

- An object belongs to the thread that exported it, and its calls run on that thread.
- A call is posted to the apartment's hidden `OleMainThreadWndClass` window. It runs when that
  thread's message loop dispatches it, or inside the thread's own wait if the thread is itself
  waiting on an outgoing call, as COM's modal loop does.
- A stub runs each method inside an exception frame of its own. An exception the method does not
  handle fails the call with `RPC_E_SERVERFAULT` and leaves the server running.

How arguments travel is the typelib marshaler's job (`layers/win32/oleaut32/marshal.js`). An
interface can cross if the registry sends it to the universal marshaler with a type library:
`ProxyStubClsid32` names PSOAInterface or PSDispatch, and `TypeLib` names the library.
`RegisterTypeLib` writes these keys for every dual and `[oleautomation]` interface.

- **What crosses:** numbers, BSTRs, ANSI and wide strings, VARIANTs (by-reference ones included),
  SAFEARRAYs, flat records, and interface pointers, which cross as further proxies.
- **`iid_is`:** supported for `IClassFactory::CreateInstance`.
- **IDispatch:** `GetTypeInfoCount`, `GetIDsOfNames` and `Invoke` cross. The by-reference
  arguments of an `Invoke` come back as they would on Windows.
- **Ownership:** COM's rules apply. The stub frees what it made for the call, the caller receives
  its `[out]` values freshly allocated, and an `[in, out]` value is freed before its replacement
  is written.

## References and lifetime

Each reference that crosses carries one count. A proxy gives back every count it holds when its
last local reference is released. The exporter's table entry releases the object when its last
remote count goes. When a process ends, everything its proxies held is released and every call it
had under way is answered `RPC_E_DISCONNECTED`, as COM's rundown does. That release is how a
server sees its last client leave, and a server that is written to exit then does so.

## Files and the registry

On Windows two processes share one volume and one registry. Here each machine has its own copy,
so `replicas.js` carries changes between them:

- **When:** before a process runs on another's behalf (each call across), and when a process
  ends.
- **What:** a process's changes are the difference between its state now and its state when it
  was last brought up to date, so another process's writes are never carried back as its own.
- **Where from:** the whole run waits for its servers to end before it finishes, so the final
  volume includes what they wrote.

## Limits

- Only the single-threaded apartment is modelled. A multithreaded-apartment server's calls are
  still posted to the thread that exported the object.
- `ITypeInfo`, from `IDispatch::GetTypeInfo`, does not cross. Neither does an interface whose
  type library does not describe it, such as a `void **` without `iid_is`.
- Records holding pointers other than BSTRs do not cross.
- The volume carries a deletion of a file a process wrote. It does not carry a deletion of a file
  that came with the bundle.
- The processes share the run's presenter and sound output. A server and a client that both draw
  or both play at once are not arbitrated.
