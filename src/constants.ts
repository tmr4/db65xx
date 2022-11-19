// memory characteristics and masks
export const BYTE_WIDTH = 8;
export const BYTE_FORMAT = "%02x";
export const WORD_WIDTH = 16;
export const WORD_FORMAT = "%04x";
export const ADDR_WIDTH = 16;
export const ADDR_FORMAT = "%04x";
export const ADDRL_WIDTH = 24;
export const ADDRL_FORMAT = "%05x";
export const byteMask = ((1 << BYTE_WIDTH) - 1);
export const addrMask = ((1 << ADDR_WIDTH) - 1);
export const addrHighMask = (byteMask << BYTE_WIDTH)
export const addrMaskL = ((1 << ADDRL_WIDTH) - 1); // *** TODO { do we need to restrict this more hardwired memory model limit? ***
export const addrBankMask = (addrHighMask << BYTE_WIDTH); // *** TODO { should this be limited to 0x110000? ***
export const spBase = 1 << BYTE_WIDTH;

// processor flags
export const NEGATIVE = 128;
export const OVERFLOW = 64;
export const UNUSED = 32;
export const BREAK = 16;
export const DECIMAL = 8;
export const INTERRUPT = 4;
export const ZERO = 2;
export const CARRY = 1;
export const MS = 32;            // 16-bit native mode
export const IRS = 16;           // 16-bit native mode

// vectors [16-bit, 8-bit]
export const RESET = 0xfffc;
export const COP = [0xffe4, 0xfff4];
export const BRK = 0xffe6;
export const ABORT = [0xffe8, 0xfff8];
export const NMI = [0xffea, 0xfffa];
export const IRQ = [0xffee, 0xfffe];
