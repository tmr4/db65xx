import { Registers } from './registers';
import { toHexString, getMemValue, setMemValue } from './util';

// Symbol types: (what's defined, other properties undefined)
//  - memory:   memory location (address and size are specified)
//  - register: (register is true)
//  - simple:   constant (value specified)
//  - C:        local variable (size, scope and offset specified)
//  - C:        function (address, size, and scope specified)
export interface ISymbol {
    name: string;       // needed for when we get symbols by scope
    address?: number;
    size?: number;       // size in bytes
    register?: boolean;
    value?: number;
    scope?: number;
    offset?: number;    // offset from C stack pointer

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
                result = getMemValue(this.mem, address, size);
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
                setMemValue(value, this.mem, address, size);
            } else if (sym.register) {
                // set register symbol
                this.registers.setRegister(name, value);
            } else {
                // a simple symbol
                sym.value = value;
            }
        } else {
            // symbol not found, create a simple symbol
            this.symbols.set(name, {name: name, value: value});
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
            this.symbols.set(reg[0], {name: reg[0], register: true});
        }
    }
}
