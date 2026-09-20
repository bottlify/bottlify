/** A stand-in for the networking client: records what it was asked and hands back a transport. */
export const opened = [];
export async function connectRelay(options){
    const transport = { options, disposed: 0, dispose(){ this.disposed++; } };
    opened.push(transport);
    return transport;
}
