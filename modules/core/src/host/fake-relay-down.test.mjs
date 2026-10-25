/** A stand-in for the networking client whose relay does not answer. */
export async function connectRelay(){
    throw new Error('relay unreachable');
}
