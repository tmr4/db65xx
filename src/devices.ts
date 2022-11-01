export interface IDisasm {
    name: string;
    mode: string;
}
import { instruct, cycletime, extracycles, disassemble } from './mpu65816';

export function instruction(name: string, mode: string, cycles: number,
                             xcycles: number = 0): Function {
    function decorate(f: Function, memberName: string, propertyDescriptor: PropertyDescriptor): Function {
        var opcode: number = 0;
        opcode = Number.parseInt(memberName.slice(5), 16);
        instruct[opcode] = propertyDescriptor.value;
        disassemble[opcode] = {name, mode};
        cycletime[opcode] = cycles;
        extracycles[opcode] = xcycles;
        return f;  // Return the original function
    }
    return decorate;
}
