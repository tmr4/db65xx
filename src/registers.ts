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

    public setRegister(register: string, x: number) {
        let value = x;
        const mpu = this._mpu;
        const mode = mpu.mode;
        const ms = mpu.MS & mpu.p;
        const irs = mpu.IRS & mpu.p;

        switch (register) {
            case 'K':
                value = value & 0xff;
                this._registers.K = value;
                mpu.pbr = value;
                break;
            case 'PC':
                value = value & 0xffff;
                mpu.pc = value;
                this._registers.PC = value;
                break;
            case 'A':
                value = value & (mode | ms ? 0xff : 0xffff);
                this._registers.A = value;
                mpu.a = value;
                break;
            case 'X':
                value = value & (mode | irs ? 0xff : 0xffff);
                this._registers.X = value;
                mpu.x = value;
                break;
            case 'Y':
                value = value & (mode | irs ? 0xff : 0xffff);
                this._registers.Y = value;
                mpu.y = value;
                break;
            case 'P':
                mpu.setP(value);
                this._registers.P = mpu.p;
                this._registers.A = mpu.a;
                this._registers.X = mpu.x;
                this._registers.Y = mpu.y;
                break;
            case 'B':
                value = value & 0xff;
                this._registers.B = value;
                mpu.dbr = value;
                break;
            case 'D':
                value = value & 0xffff;
                this._registers.D = value;
                mpu.dpr = value;
                break;
            case 'SP':
                value = value & (mode ? 0xff : 0xffff);
                this._registers.SP = value;
                mpu.sp = value;
                break;
            default:
                break;
        }
    }

    public getRegister(register: string): number | undefined {
        const mpu = this._mpu;
        switch (register) {
            case 'K':
                return mpu.pbr;
            case 'PC':
                return mpu.pc;
            case 'A':
                return mpu.a;
            case 'X':
                return mpu.x;
            case 'Y':
                return mpu.y;
            case 'P':
                return mpu.p;
            case 'B':
                return mpu.dbr;
            case 'D':
                return mpu.dpr;
            case 'SP':
                return mpu.sp;
            default:
                return undefined;
        }
    }

    public setSatusRegister(x: string) {
        const mpu = this._mpu;
        let p = 0;

        if (x.includes('N') || x.includes('n')) {
            p |= mpu.NEGATIVE;
        }
        if (x.includes('V') || x.includes('v')) {
            p |= mpu.OVERFLOW;
        }
        if (x.includes('M') || x.includes('m')) {
            p |= mpu.MS;
        }
        if (x.includes('X') || x.includes('x')) {
            p |= mpu.IRS;
        }
        if (x.includes('D') || x.includes('d')) {
            p |= mpu.DECIMAL;
        }
        if (x.includes('I') || x.includes('i')) {
            p |= mpu.INTERRUPT;
        }
        if (x.includes('Z') || x.includes('z')) {
            p |= mpu.ZERO;
        }
        if (x.includes('C') || x.includes('c')) {
            p |= mpu.CARRY;
        }

        mpu.setP(p);
        this._registers.P = mpu.p;
        this._registers.A = mpu.a;
        this._registers.X = mpu.x;
        this._registers.Y = mpu.y;
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

    public setFlag(name: string, value: number) {
        const mpu = this._mpu;
        let p = mpu.p;
        let flag = 0;

        // note the flag's bit position and change its internal value
        // except for M and X where we need to see if flag is actually changed
        switch (name) {
            case 'N':
                this._p.N = flag;
                flag = mpu.NEGATIVE;
                break;
            case 'V':
                this._p.V = flag;
                flag = mpu.OVERFLOW;
                break;
            case 'M':
                flag = mpu.MS;
                break;
            case 'X':
                flag = mpu.IRS;
                break;
            case 'D':
                this._p.D = flag;
                flag = mpu.DECIMAL;
                break;
            case 'I':
                this._p.I = flag;
                flag = mpu.INTERRUPT;
                break;
            case 'Z':
                this._p.Z = flag;
                flag = mpu.ZERO;
                break;
            case 'C':
                this._p.C = flag;
                flag = mpu.CARRY;
                break;
            default:
                break;
        }

        // update p for flag being modified
        if (value) {
            p |= flag;
        } else {
            p &= ~flag;
        }

        // update mpu status register
        // this might not do anything depending on the processor state
        // and flag being changed
        mpu.setP(p);

        // update the internal M or X flag with the actual result of the change
        switch (name) {
            case 'M':
                this._p.M = (mpu.p & mpu.MS) !== 0 ? 1 : 0;
                break;
            case 'X':
                this._p.X = (mpu.p & mpu.IRS) !== 0 ? 1 : 0;
                break;
            default:
                break;
        }
    }

    public getFlag(name: string): number | undefined {
        const p = this.p;
        switch (name) {
            case 'N':
                return p.N;
            case 'V':
                return p.V;
            case 'M':
                return p.M;
            case 'X':
                return p.X;
            case 'D':
                return p.D;
            case 'I':
                return p.I;
            case 'Z':
                return p.Z;
            case 'C':
                return p.C;
            default:
                return undefined;
        }
    }

    public status(): string {
        let status = '';
        const p = this.p;
        if (p.N) {
            status += 'N';
        } else {
            status += '-';
        }
        if (p.V) {
            status += 'V';
        } else {
            status += '-';
        }
        if (p.M) {
            status += 'M';
        } else {
            status += '-';
        }
        if (p.X) {
            status += 'X';
        } else {
            status += '-';
        }
        if (p.D) {
            status += 'D';
        } else {
            status += '-';
        }
        if (p.I) {
            status += 'I';
        } else {
            status += '-';
        }
        if (p.Z) {
            status += 'Z';
        } else {
            status += '-';
        }
        if (p.C) {
            status += 'C';
        } else {
            status += '-';
        }
        return status;
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
