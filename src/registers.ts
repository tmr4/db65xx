/* eslint-disable @typescript-eslint/naming-convention */

import { MPU65816 } from './mpu65816';

interface IRegisters6502 {
    A: number;
    X: number;
    Y: number;
    P: number;
    SP: number;
    PC: number;
}

export interface IRegisters65816 extends IRegisters6502 {
    D: number;
    B: number;
    K: number;
}

interface Flags65816 {
    N: number;
    V: number;
    M: number;
    X: number;
    D: number;
    I: number;
    Z: number;
    C: number;
}

export class Registers {
    private _mpu: MPU65816;
    private _registers: IRegisters65816 = { A: 0, X: 0, Y: 0, P: 0, SP: 0, PC: 0, B: 0, D: 0, K: 0 };
    get registers() {
        const mpu = this._mpu;
        return {
            K: mpu.pbr,
            PC: mpu.pc,
            A: mpu.a,
            X: mpu.x,
            Y: mpu.y,
            P: mpu.p,
            B: mpu.dbr,
            D: mpu.dpr,
            SP: mpu.sp,
        };
    }

    public setRegister(register: string, value: number) {
        const mpu = this._mpu;
        switch (register) {
            case 'K':
                this._registers.K = value;
                mpu.pbr = value;
                break;
            case 'PC':
                mpu.pc = value;
                this._registers.PC = value;
                break;
            case 'A':
                this._registers.A = value;
                mpu.a = value;
                break;
            case 'X':
                this._registers.X = value;
                mpu.x = value;
                break;
            case 'Y':
                this._registers.Y = value;
                mpu.y = value;
                break;
            case 'P':
                this._registers.P = value;
                mpu.p = value;
                break;
            case 'B':
                this._registers.B = value;
                mpu.dbr = value;
                break;
            case 'D':
                this._registers.D = value;
                mpu.dpr = value;
                break;
            case 'SP':
                this._registers.SP = value;
                mpu.sp = value;
                break;
            default:
                break;
        }
    }

    private _p: Flags65816 = { N: 0, V: 0, M: 0, X: 0, D: 0, I: 0, Z: 0, C: 0 };
    get p() {
        const mpu = this._mpu;
        const p = this._mpu.p;
        return {
            N: (p & mpu.NEGATIVE) !== 0 ? 1 : 0,
            V: (p & mpu.OVERFLOW) !== 0 ? 1 : 0,
            M: (p & mpu.MS) !== 0 ? 1 : 0,
            X: (p & mpu.IRS) !== 0 ? 1 : 0,
            D: (p & mpu.DECIMAL) !== 0 ? 1 : 0,
            I: (p & mpu.INTERRUPT) !== 0 ? 1 : 0,
            Z: (p & mpu.ZERO) !== 0 ? 1 : 0,
            C: (p & mpu.CARRY) !== 0 ? 1 : 0
        };
    }

    public setFlag(register: string, value: number) {
        const mpu = this._mpu;
        const flag = value === 0 ? 0 : 1;
        switch (register) {
            case 'N':
                this._p.N = flag;
                mpu.p |= flag << mpu.NEGATIVE;
                break;
            case 'V':
                this._p.V = flag;
                mpu.pbr = flag << mpu.OVERFLOW;
                break;
            case 'M':
                this._p.M = flag;
                mpu.a = flag << mpu.MS;
                break;
            case 'X':
                this._p.X = flag;
                mpu.x = flag << mpu.IRS;
                break;
            case 'D':
                this._p.D = flag;
                mpu.y = flag << mpu.DECIMAL;
                break;
            case 'I':
                this._p.I = flag;
                mpu.p = flag << mpu.INTERRUPT;
                break;
            case 'Z':
                this._p.Z = flag;
                mpu.dbr = flag << mpu.ZERO;
                break;
            case 'C':
                this._p.C = flag;
                mpu.dpr = flag << mpu.CARRY;
                break;
            default:
                break;
        }
    }

    private _address: number = 0;
    get address() {
        const mpu = this._mpu;
        return mpu.pc + (mpu.pbr << 16);
    }

    constructor(mpu: MPU65816) {
        this._mpu = mpu;
    }
}
