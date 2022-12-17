import { Registers } from './registers';
import { toHexString } from './util';

// Symbol types:
//  - memory:   a named memory location (address and size are specified, register and value undefined)
//  - register: a named register if true (other properties undefined)
//  - simple:   a named constant
export interface ISymbol {
    address?: number;
    size?: number;       // size in bytes
    register?: boolean;
    value?: number;

    // *** TODO: consider adding file ID
    // this isn't available from VICE symbol file
    // but may be useful for identical symbols in
    // different source files.  I think the dbgfile
    // has this covered and referencing file here isn't needed. ***
    //fileId: number;
}

export class Symbols {
    private mem: Uint8Array;
    private symbols = new Map<string, ISymbol>(); // symbol/address pair
    private registers!: Registers;

    public constructor(mem: Uint8Array, registers?: Registers) {
        //const this.mem = this.ee65xx.obsMemory.memory;
        this.mem = mem;

        if (registers) {
            this.addRegisters(registers);
        }
    }

    // get name from symbols map
    public get(name: string): ISymbol | undefined {
        return this.symbols.get(name);
    }

    // set name in symbols map
    public set(name: string, symbol: ISymbol) {
        this.symbols.set(name, symbol);
    }

    public entries() {
        return this.symbols.entries();
    }

    // get address of name
    public getAddress(name: string): number | undefined {
        return this.symbols.get(name)?.address;
    }

    // return value of name
    public getValue(name: string): number | undefined {
        let result: number | undefined = undefined;
        const sym = this.symbols.get(name);

        if (sym) {
            // symbol exists, get its value according to its type
            const address = sym.address;
            const size = sym.size;
            if ((address !== undefined) && size) {
                switch (size) {
                    case 1:
                        result = this.mem[address];
                        break;
                    case 2:
                        result = (this.mem[address] + (this.mem[address + 1] << 8));
                        break;
                    case 3:
                        result = this.mem[address] +
                            (this.mem[address + 1] << 8) +
                            (this.mem[address + 2] << 16);
                        break;
                    case 4:
                        result = this.mem[address] +
                            (this.mem[address + 1] << 8) +
                            (this.mem[address + 2] << 16) +
                            (this.mem[address + 3] << 24);
                        break;
                    default:
                        result = this.mem[address];
                        break;
                }
            } else if (sym.register) {
                // get register symbol
                result = this.registers.getRegister(name);
            } else {
                // a simple symbol
                result = sym.value;
            }
        }
        return result;
    }

    // set the value of name
    // if it doesn't exist, create it
    public setValue(name: string, value: number) {
        const sym = this.symbols.get(name);

        if (sym) {
            // symbol exists, set its value according to its type
            const address = sym.address;
            const size = sym.size;
            if (address !== undefined && size) {
                // a memory symbol
                this.mem[address] = value & 0xff;
                switch (size) {
                    case 4:
                        this.mem[address + 3] = (value & 0xff000000) >> 24;
                    // fall through
                    case 3:
                        this.mem[address + 2] = (value & 0xff0000) >> 16;
                    // fall through
                    case 2:
                        this.mem[address + 1] = (value & 0xff00) >> 8;
                        break;
                    default:
                        break;
                }
            } else if (sym.register) {
                // set register symbol
                this.registers.setRegister(name, value);
            } else {
                // a simple symbol
                sym.value = value;
            }
        } else {
            // symbol not found, create a simple symbol
            this.symbols.set(name, {value: value});
        }
    }

    // return value of name as string
    public getString(name: string): string | undefined {
        let result: string | undefined = undefined;
        const sym = this.symbols.get(name);

        if (sym) {
            const size = sym.size;
            if (size && (size > 4)) {
                result = toHexString(this.mem.slice(sym.address, sym.address! + size));
            } else {
                result = this.getValue(name)!.toString(16);
            }
        }
        return result;
    }

    private addRegisters(registers: Registers) {
        //
        this.registers = registers;
        for (const reg of Object.entries(registers.registers)) {
            this.symbols.set(reg[0], {register: true});
        }
    }
}
