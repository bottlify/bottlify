# `@bottlify/networking`

TCP and UDP for a browser tab, over one WebSocket. A relay server in Node holds the real sockets;
the client gives a page sockets through it. Pages in the same room share a private network and
reach each other directly; outside the room the relay connects only to hosts you allow.
[`@bottlify/core`](https://www.npmjs.com/package/@bottlify/core) uses it for Winsock, and anything
else can use it too. Part of [Bottlify](https://github.com/bottlify/bottlify).

## Install

```sh
npm install @bottlify/networking
```

## Use

The relay, attached to an HTTPS server you already have:

```js
import { createRelayServer } from '@bottlify/networking/server';

const relay = createRelayServer({ server: httpsServer, path: '/relay',
    policy: ({ host })=>host === 'logon.example.com' });   // which outside hosts are allowed
httpsServer.listen(443, ()=>relay.listen());
```

A page:

```js
import { connectRelay } from '@bottlify/networking';

const net = await connectRelay({ url: 'wss://play.example.com/relay', room: 'demo' });
net.attach({ datagram: (port, from, bytes)=>console.log(port, from, bytes) });
net.listen(false, 5000);                                    // UDP port 5000 in the room
```

A Bottlify program gets the network through `createApp({ network: { module, url, room } })`.

## Documentation

[The relay's options, the client's API, the wire protocol](https://github.com/bottlify/bottlify/blob/main/docs/networking/README.md)

MPL-2.0.
