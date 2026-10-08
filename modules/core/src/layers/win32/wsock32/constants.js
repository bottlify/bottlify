/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The numbers Winsock is, as opposed to what it does.
 *
 * Two of these tables are worth reading before touching anything below them.
 *
 * The error codes are not errno. Winsock reports failure as SOCKET_ERROR and
 * puts the reason in a separate slot, so every failing path here has two
 * halves and a caller that reads only the return value learns nothing.
 *
 * The ordinal table is the reason this file has a table at all. A program may
 * import these by ordinal instead of by name -- both games in front of us do,
 * one of them exclusively -- and an ordinal is not a position in an export
 * list. It is a fixed number belonging to that library, so the table has to be
 * written down rather than derived, and it differs between wsock32 and ws2_32
 * in exactly the places noted.
 */

/** Address families. AF_INET is the only one a socket may be created with here. */
export const AF_INET = 2;

/** Socket types. */
export const SOCK_STREAM = 1;
export const SOCK_DGRAM = 2;

/** Protocols. Zero means "the usual one for this type", which is how most callers ask. */
export const IPPROTO_TCP = 6;
export const IPPROTO_UDP = 17;

/** What a failed call returns, and what a failed socket() returns. */
export const SOCKET_ERROR = 0xffffffff;
export const INVALID_SOCKET = 0xffffffff;

/** Addresses that mean something other than a host. */
export const INADDR_ANY = 0;
export const INADDR_LOOPBACK = 0x7f000001;
export const INADDR_BROADCAST = 0xffffffff;
export const INADDR_NONE = 0xffffffff;

/** protoent, for getprotobyname: the name, the aliases, then the number as a short. */
export const PROTOENT = Object.freeze({ p_name: 0, p_aliases: 4, p_proto: 8, SIZE: 12 });

/** shutdown(how). */
export const SD_RECEIVE = 0;
export const SD_SEND = 1;
export const SD_BOTH = 2;

/**
 * The error codes this surface reports. Winsock's are offset by 10000 from the
 * BSD names they are otherwise identical to.
 */
export const WSAEINTR = 10004;
export const WSAEBADF = 10009;
export const WSAEFAULT = 10014;
export const WSAEINVAL = 10022;
export const WSAEMFILE = 10024;
export const WSAEWOULDBLOCK = 10035;
export const WSAEINPROGRESS = 10036;
export const WSAEALREADY = 10037;
export const WSAENOTSOCK = 10038;
export const WSAEMSGSIZE = 10040;
export const WSAEPROTONOSUPPORT = 10043;
export const WSAEOPNOTSUPP = 10045;
export const WSAEAFNOSUPPORT = 10047;
export const WSAEADDRINUSE = 10048;
export const WSAEADDRNOTAVAIL = 10049;
export const WSAENETDOWN = 10050;
export const WSAENETUNREACH = 10051;
export const WSAECONNABORTED = 10053;
export const WSAECONNRESET = 10054;
export const WSAENOBUFS = 10055;
export const WSAEISCONN = 10056;
export const WSAENOTCONN = 10057;
export const WSAETIMEDOUT = 10060;
export const WSAECONNREFUSED = 10061;
export const WSANOTINITIALISED = 10093;
export const WSAHOST_NOT_FOUND = 11001;
export const WSATRY_AGAIN = 11002;
export const WSANO_RECOVERY = 11003;
export const WSANO_DATA = 11004;
export const WSAESOCKTNOSUPPORT = 10044;
export const WSATYPE_NOT_FOUND = 10109;
export const WSA_IO_PENDING = 997;

/**
 * The codes the event and overlapped calls report. These are the Win32 errors
 * under other names -- a WSAEVENT is a kernel event, and its failures are the
 * kernel's -- which is why they sit far below the 10000 block.
 */
export const WSA_INVALID_HANDLE = 6;
export const WSA_NOT_ENOUGH_MEMORY = 8;
export const WSA_INVALID_PARAMETER = 87;
export const WSA_OPERATION_ABORTED = 995;
export const WSA_IO_INCOMPLETE = 996;

/** WSAWaitForMultipleEvents: the most it takes, and what it answers when it fails. */
export const WSA_MAXIMUM_WAIT_EVENTS = 64;
export const WSA_WAIT_FAILED = 0xffffffff;

/** The other families a caller may name; neither is served here. */
export const AF_UNSPEC = 0;
export const AF_INET6 = 23;

/** WSASocket's "take this one from the protocol description" for af, type or protocol. */
export const FROM_PROTOCOL_INFO = -1;

/**
 * WSAPROTOCOL_INFOA, as far as WSASocket reads it: the family, type and
 * protocol, after four service flags, the provider flags, its GUID, the
 * catalogue entry, the protocol chain and the version.
 */
export const WSAPROTOCOL_INFO = Object.freeze({
    iAddressFamily: 76,
    iSocketType: 88,
    iProtocol: 92,
});

/**
 * WSAOVERLAPPED: the status and the byte count the system keeps in the first
 * two words, and the event it signals at completion.
 */
export const WSAOVERLAPPED = Object.freeze({ Internal: 0, InternalHigh: 4, hEvent: 16 });

/** ADDRINFOA on 32-bit Windows, eight words; a node's address follows it here. */
export const ADDRINFO = Object.freeze({
    ai_flags: 0,
    ai_family: 4,
    ai_socktype: 8,
    ai_protocol: 12,
    ai_addrlen: 16,
    ai_canonname: 20,
    ai_addr: 24,
    ai_next: 28,
    SIZE: 32,
});

/** getaddrinfo's flags, as Windows XP takes them. */
export const AI_PASSIVE = 0x1;
export const AI_CANONNAME = 0x2;
export const AI_NUMERICHOST = 0x4;

/** getnameinfo's flags. */
export const NI_NOFQDN = 0x01;
export const NI_NUMERICHOST = 0x02;
export const NI_NAMEREQD = 0x04;
export const NI_NUMERICSERV = 0x08;
export const NI_DGRAM = 0x10;

/** The raw-type sockets a getaddrinfo hint may name, beside the two served. */
export const SOCK_RAW = 3;
export const SOCK_RDM = 4;
export const SOCK_SEQPACKET = 5;

/**
 * ioctlsocket commands. These are encoded IOCTLs rather than small integers, so
 * a caller that got the encoding wrong lands on no command at all rather than
 * on a neighbouring one.
 */
export const FIONBIO = 0x8004667e;
export const FIONREAD = 0x4004667f;

/** setsockopt/getsockopt levels. */
export const SOL_SOCKET = 0xffff;
export const IPPROTO_IP = 0;

/**
 * The network events WSAAsyncSelect and WSAEventSelect both arm a socket for,
 * and the bit positions WSAEnumNetworkEvents' iErrorCode[] answers about --
 * position N is the error for bit `1 << N`, which is why these are powers of
 * two rather than an enumeration.
 */
export const FD_READ = 0x0001;
export const FD_WRITE = 0x0002;
export const FD_OOB = 0x0004;
export const FD_ACCEPT = 0x0008;
export const FD_CONNECT = 0x0010;
export const FD_CLOSE = 0x0020;

/** The length of WSANETWORKEVENTS.iErrorCode, whatever the caller's mask uses. */
export const FD_MAX_EVENTS = 10;

/**
 * The socket-level options we answer for. Everything else is accepted and
 * remembered without being enforced, because a program that sets a buffer size
 * and reads it back must see what it set, and nothing below honours it anyway.
 *
 * SO_ERROR is the one that has to be real: a framework that fails a connect
 * reads it afterwards to find out why, and it is documented to clear itself.
 */
export const SO_REUSEADDR = 0x0004;
export const SO_KEEPALIVE = 0x0008;
export const SO_BROADCAST = 0x0020;
export const SO_SNDBUF = 0x1001;
export const SO_RCVBUF = 0x1002;
export const SO_ERROR = 0x1007;
export const SO_TYPE = 0x1008;
export const TCP_NODELAY = 0x0001;

/** WSAStartup's WSADATA, laid out the way the guest compiled it. */
export const WSADATA = Object.freeze({
    wVersion: 0,
    wHighVersion: 2,
    szDescription: 4,
    szSystemStatus: 261,
    iMaxSockets: 390,
    iMaxUdpDg: 392,
    lpVendorInfo: 394,
    SIZE: 400,
});

/** What we tell a caller about ourselves, once it has asked. */
export const WSADESCRIPTION = 'Bottlify Sockets';
export const WSASYSSTATUS = 'Running';

/**
 * hostent, for gethostbyname. Every pointer in it aims at memory we allocate
 * and keep, because the structure is documented as belonging to the library and
 * a caller is entitled to read it until its next call on the same thread.
 */
export const HOSTENT = Object.freeze({
    h_name: 0,
    h_aliases: 4,
    h_addrtype: 8,
    h_length: 10,
    h_addr_list: 12,
    SIZE: 16,
});

/**
 * wsock32.dll's ordinals.
 *
 * A PE may import any of these by number, and then no name ever appears in the
 * import table. Ordinals 1-23 are the BSD socket calls, 51-57 the resolver, and
 * 101-116 the Windows-specific additions; the gaps are real and belong to
 * entries this does not implement.
 *
 * Three of these disagree with ws2_32, which is why the two libraries cannot
 * share one table: 10, 11 and 12 are rotated there.
 */
export const WSOCK32_ORDINALS = Object.freeze({
    1: 'accept',
    2: 'bind',
    3: 'closesocket',
    4: 'connect',
    5: 'getpeername',
    6: 'getsockname',
    7: 'getsockopt',
    8: 'htonl',
    9: 'htons',
    10: 'inet_addr',
    11: 'inet_ntoa',
    12: 'ioctlsocket',
    13: 'listen',
    14: 'ntohl',
    15: 'ntohs',
    16: 'recv',
    17: 'recvfrom',
    18: 'select',
    19: 'send',
    20: 'sendto',
    21: 'setsockopt',
    22: 'shutdown',
    23: 'socket',
    51: 'gethostbyaddr',
    52: 'gethostbyname',
    53: 'getprotobyname',
    54: 'getprotobynumber',
    55: 'getservbyname',
    56: 'getservbyport',
    57: 'gethostname',
    101: 'WSAAsyncSelect',
    103: 'WSAAsyncGetHostByName',
    108: 'WSACancelAsyncRequest',
    111: 'WSAGetLastError',
    112: 'WSASetLastError',
    115: 'WSAStartup',
    116: 'WSACleanup',
    151: '__WSAFDIsSet',
});

/**
 * ws2_32.dll's ordinals. The same table with 10, 11 and 12 rotated: the newer
 * library puts ioctlsocket back in BSD order and pushes the two address helpers
 * along by one.
 *
 * Unverified, and marked as such deliberately -- the ordinals above are
 * corroborated by what a real program actually imports, and these are not,
 * because nothing in front of us imports ws2_32 by number.
 */
export const WS2_32_ORDINALS = Object.freeze({
    ...WSOCK32_ORDINALS,
    10: 'ioctlsocket',
    11: 'inet_addr',
    12: 'inet_ntoa',
});
