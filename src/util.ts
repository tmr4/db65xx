
// returns the IEEE-754 32-bit representation of bytes
function toIEEE32(bytes: Uint8Array): string {

    // bytes is the internal representation of a floating point value
    // for example 1.2 in bytes is (from lsb to msb where lsb is below msb in memory):
    // byte  0  1  2  3  4  5  6  7
    //      99 99 99 99 7F 00 40 00
    //      xx mm mm mm ee    s
    //
    // where s is a sign bit, ee is an exponent byte, mm is a 24-bit
    // mantissa and xx is a guard byte used for precision and rounding.
    // (byte 7 is a status byte, byte 5 is not used and byte 4 has a
    // hidden 1 as it's most significant bit).
    //
    // Reversing and expressing in bits:
    //
    // byte 6         4         3         2         1         0 guard bits
    // bits 0         01111111  10011001  10011001  10011001  10011001
    //      s-------  eeeeeeee  1mmmmmmm  mmmmmmmm  mmmmmmmm  xxxxxxxx
    //
    // compacting and dropping the hidden bit gives us the IEEE-754 32-bit value:
    //      seeeeeee emmmmmmm mmmmmmmm mmmmmmmm
    //      00111111 10011001 10011001 10011001 + 1 as the guard bits are > $80
    //
    //      B4----->  B3----> W1--------------> variables used below
    //
    // This is 3F99999A for floating point 1.2

    let ieee32: string = '';
    if (bytes.length >= 8) {
        // convert the various pieces
        const sign = (bytes[6] & 0x80) << 8;
        const exph = bytes[4] >> 1;
        const expl = bytes[4] & 1;

        const B4 = sign + exph;
        const B3 = (expl << 7) + (bytes[3] & 0x7f); // drop hidden bit
        const W1 = bytes[1] + (bytes[2] << 8) + (bytes[0] > 0x80 ? 1 : 0);

        // combine these to ieee32
        ieee32 = ((B4 << 24) + (B3 << 16) + W1).toString(16);
    }
    return ieee32;
}

export function toHexString(byteArray, size: number = 8, length: number = 47) {
    if (size === 8) { // bytes
        return Array.from(byteArray, function (byte: number) {
            return ('0' + (byte & 0xFF).toString(16)).slice(-2);
        }).join(' '); //.slice(0, length);
    } else if (size === 16) { // words
        const uint16Array = new Uint16Array(byteArray.buffer, 0, byteArray.length / Uint16Array.BYTES_PER_ELEMENT);
        return Array.from(uint16Array, function (word: number) {
            return ('000' + (word & 0xFFFF).toString(16)).slice(-4);
        }).join(' '); //.slice(0, length);
    } else if (size === 32) { // IEEE-754 format
        let ieee32 = '';
        for (let i = 0; i < byteArray.length; i += 8) {
            ieee32 += toIEEE32(byteArray.slice(i, i + 8)) + ' ';
        }
        return ieee32;
    } else if (size === 64) { // internal floating-point format
        const uint32Array = new Uint32Array(byteArray.buffer, 0, byteArray.length / Uint32Array.BYTES_PER_ELEMENT);
        let fp = '';
        for (let i = 0; i < uint32Array.length; i += 2) {
            // & 0xFFFFFFFF turns these into signed numbers
            //            fp += ('0000000' + (uint32Array[i + 1] & 0xFFFFFFFF).toString(16)).slice(-8) + '-';
            //            fp += ('0000000' + (uint32Array[i] & 0xFFFFFFFF).toString(16)).slice(-8) + ' ';
            fp += ('0000000' + uint32Array[i + 1].toString(16)).slice(-8) + '-';
            fp += ('0000000' + uint32Array[i].toString(16)).slice(-8) + ' ';
        }
        return fp;
        //        return Array.from(uint32Array, function (dword: number) {
        //            return ('0000000' + (dword & 0xFFFFFFFF).toString(16)).slice(-8);
        //        }).join(' ').slice(0, length);
    } else {
        return Array.from(byteArray, function (byte: number) {
            return ('0' + (byte & 0xFF).toString(16)).slice(-2);
        }).join(' ').slice(0, length);
    }
}
