# `@bottlify/networking`

TCP and UDP for a browser tab, over one WebSocket.

A page cannot open a TCP connection or bind a UDP port; it can open a WebSocket. This package gets
around that from both ends: a **relay** server (Node, no dependencies) that holds real sockets, and
a **client** that gives the page sockets through it (streams, datagrams, listening ports, name
lookups). Pages that join the same **room** share a private network, `10.86.0.0/16`,
and reach each other directly; anything outside the room is a real connection the relay opens,
only to the hosts you allow.

`@bottlify/core` uses it to give a Windows program Winsock, but it does not need the engine: a
game, an emulator or a tool of your own can use the same transport.

```
page A ── wss ──┐                ┌── page B        (same room: 10.86.0.1 ↔ 10.86.0.2)
                ├── relay ───────┤
page C ── wss ──┘                └── TCP/UDP to an allowed host on the internet
```

## Run a relay

```sh
npm run relay -w @bottlify/networking -- --port 8787
# or, from modules/networking:
node src/server/cli.js --port 8787 --allow logon.example.com --allow '*.example.net'
node src/server/cli.js --port 8787 --origin https://play.example.com
```

| Option | Default | What it does |
| --- | --- | --- |
| `--port` | 8787 | The port it listens on. |
| `--host` | `0.0.0.0` | The address it binds. |
| `--allow host` | nothing | A host the relay may open real connections to; `*.example.net` allows a suffix. Repeat for more. |
| `--origin url` | any | Only pages from these origins may connect (checked at the handshake). Repeat for more. |

With no `--allow`, a relay is a private LAN per room and never an open proxy. A page served over
HTTPS may only open `wss://`, so in a deployment put TLS in front of it, or attach it to the
HTTPS server you already have:

```js
import { createRelayServer } from '@bottlify/networking/server';

const relay = createRelayServer({ server: httpsServer, path: '/relay',
    policy: ({ room, peer, protocol, host, port })=>host === 'logon.example.com' });
httpsServer.listen(443, ()=>relay.listen());
```

`policy` decides every outbound connection; it sees the host *name* when the page looked it up
through the relay, so an allowlist reads the way it was meant. `createRelayServer({ port })` runs
standalone.

## Give a Bottlify program the network

```js
const app = await createApp({
    ...options,
    network: {
        module: '/networking/src/client/index.js',  // where the page serves this package's client
        url: 'wss://play.example.com/relay',
        room: 'my-game-lobby',                      // everyone in it is on one LAN
    },
});
```

The engine runs in a worker, so it is given the client's URL and connects from there. Without
`network`, Winsock has a loopback adapter only. A program's broadcast reaches every peer of its
room and stops there, so two sessions in different rooms never find each other.

## Use it on your own

```js
import { connectRelay } from '@bottlify/networking';

const net = await connectRelay({ url: 'wss://relay.example.com', room: 'demo' });
net.localAddress();                 // 10.86.0.x in host byte order, assigned on joining

net.attach({
    datagram: (port, from, bytes)=>console.log(port, from, new TextDecoder().decode(bytes)),
    accepted: (port, streamId, remote)=>{},     // a peer connected to a port you listen on
    received: (streamId, bytes)=>{},            // bytes on a stream
    disconnected: (streamId, error)=>{},
    lost: error=>{},                            // the relay link dropped: every socket is gone
});

// UDP: bind a port, send to a peer of the room.
net.listen(false, 5000);
net.sendTo({ host: net.localAddress(), port: 5000 }, { host: peerAddress, port: 5000 }, bytes);

// TCP: to a peer, or to an allowed host outside.
const [host] = await net.resolve('logon.example.com');
const { error } = await net.connect(1, { host, port: 6112 });   // 1: a stream id you choose
net.send(1, bytes);
net.disconnect(1, false);
```

Addresses are `{ host, port }`, the host a 32-bit number in host byte order. `listen(true, port)`
accepts streams. A dropped link is reported through `lost`, never repaired silently: reconnecting
would mean a new address and an empty room. Node 22 and later has `WebSocket` built in, so the
client runs there too.

## The wire

`@bottlify/networking/protocol` is shared by both halves, so they cannot drift apart. Joining and
the roster are JSON text frames; everything else is a binary frame with a twenty-byte header the
relay routes without reading the payload, so one `send` is one frame and a datagram keeps its
boundaries. The RFC 6455 server side is in `src/server/websocket.js`, about a hundred lines.

Inside `@bottlify/core` the seam is the transport contract in
`modules/core/src/layers/win32/wsock32/transport.js`: every part of it is optional, and what is
missing behaves as no network. `createApp({ win32: { network: transport } })` takes any object
implementing it, when the engine runs on the page's own thread (`host: 'thread'`).

## Tests

```sh
npm test -w @bottlify/networking
```

Frame and control codecs; the relay's routing through fake peers; the WebSocket server against
Node's own client, fragmented and interleaved frames included; the client transport, including what
happens to a dial, a lookup and an open stream when the link drops underneath them.
