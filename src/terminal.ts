import * as vscode from 'vscode';
import { TextEncoder, TextDecoder } from 'node:util';

import { setLastChar } from './via65c22';

//export enum TerminalLocation {
//    Panel = 0,
//    Editor = 1,
//}
//
//export interface TerminalOptions {
//    location?: TerminalLocation | TerminalEditorLocationOptions | TerminalSplitLocationOptions;
//}
//
//export interface ExtensionTerminalOptions {
//    name: string;
//    location?: TerminalLocation | TerminalEditorLocationOptions | TerminalSplitLocationOptions;
//    pty: vscode.Pseudoterminal;
//}
//
//export interface TerminalEditorLocationOptions {
//    /**
//     * A view column in which the {@link Terminal terminal} should be shown in the editor area.
//     * Use {@link ViewColumn.Active active} to open in the active editor group, other values are
//     * adjusted to be `Min(column, columnCount + 1)`, the
//     * {@link ViewColumn.Active active}-column is not adjusted. Use
//     * {@linkcode ViewColumn.Beside} to open the editor to the side of the currently active one.
//     */
//    viewColumn: vscode.ViewColumn;
//    /**
//     * An optional flag that when `true` will stop the {@link Terminal} from taking focus.
//     */
//    preserveFocus?: boolean;
//}
//
//export interface TerminalSplitLocationOptions {
//    /**
//     * The parent terminal to split this terminal beside. This works whether the parent terminal
//     * is in the panel or the editor area.
//     */
//    parentTerminal: vscode.Terminal;
//}
//const termEdLocation: TerminalEditorLocationOptions = {
//    viewColumn: vscode.ViewColumn.Two,
//    //    viewColumn: vscode.ViewColumn.Active,
//    preserveFocus: false
//};

// *******************************************************************************************
// Simple terminal I/O support

var waiting = false;

// wriate ascii byte to terminal
export function putc(byte: number): void {
    terminalWrite(String.fromCharCode(byte));
}

// return acii byte from terminal buffer if available
// otherwise set waiting flag to true to allow
// execution engine to throttle its polling
export function getc(value: number): number {
    const char = terminalRead();
    if (char !== '') {
        const utf8Encode = new TextEncoder();
        const byte = utf8Encode.encode(char)[0];
        waiting = false;
        return byte;
    } else {
        waiting = true;
        return 0;
    }
}


// *******************************************************************************************
// VS Code terminal

export class Terminal {
    _terminal: vscode.Terminal;
    _writeEmitter: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
    public get writeEmitter() {
        return this._writeEmitter;
    }
    _lastChar: string;
    _kbhit: boolean;
    public get kbhit() {
        return this._kbhit;
    }

    private buffer: string = '';
    private in = 0;
    private out = 0;

    public constructor(name: string, useVIA: boolean = false) {
        this._terminal = this.terminalCreate(name, useVIA);
        this._lastChar = '';
        this._kbhit = false;
    }

    private terminalCreate(name: string, useVIA: boolean): vscode.Terminal {
        const pty = {
            onDidWrite: this._writeEmitter.event,
            open: () => this._writeEmitter.fire('VS Code 65xx Debugger\r\n\r\n'),
            close: () => { /* *** TODO: add 'end' event *** */ },
            handleInput: (data: string) => {
                if(useVIA) {
                    setLastChar(data);
                } else {
                    if (data === '\x7f') { // Backspace
                        if (this.buffer.length === 0) {
                            return;
                        }

                        //this.buffer = this.buffer.slice(0, this.buffer.length - 1);

                        // Move cursor backward
                        this._writeEmitter.fire('\x1b[D');

                        // Delete character
                        this._writeEmitter.fire('\x1b[P');
                        //this.in--;
                        this.in++;
                        this.buffer += new TextDecoder().decode(Buffer.from('\x08'));
                        return;
                    } else if (data === '\r') {
                        this._writeEmitter.fire("\n");
                    }
                    this.buffer += data;
                    this.in++;
                    this._writeEmitter.fire(data);
                }
            }
        };
//        const termOptions: vscode.ExtensionTerminalOptions = { name: `65816 Debug`, location: vscode.TerminalLocation.Panel, pty: pty };
        const termOptions: vscode.ExtensionTerminalOptions = { name: name, location: vscode.TerminalLocation.Panel, pty: pty };
        //    const terminal = vscode.window.createTerminal({ name: `65816 Debug`, pty });
        const terminal = vscode.window.createTerminal(termOptions);
        terminal.show();
        return terminal;
    }

    public terminalClear(): void {
        this.in = 0;
        this.out = 0;
        this.buffer = '';
        this._lastChar = '';
        this._kbhit = false;
        this._writeEmitter.fire('\x1b[2J\x1b[3J\x1b[;H');
    }

    public terminalWrite(char: string): void {
        this._writeEmitter.fire(char);
        if (char === '\r') {
            this._writeEmitter.fire("\n");
        }
    }

    public terminalRead(): string {
        if(this._kbhit) {
            return this._lastChar;
        }
        return '';
    }

    public terminalReadBuf(): string {
        if (this.in > this.out) {
            const char = this.buffer[this.out];
            this.out++;
            if (char === '\r') { // Enter
                // trim buffer to eliminate previous line
                this.buffer = this.buffer.slice(this.out);
                this.in = this.in - this.out;
                this.out = 0;
            }
            return char;
        }
        return '';
    }

    public dispose() {
        this._terminal.dispose();
    }
}

var terminal: Terminal | undefined;

export function terminalDispose() {
    waiting = false;
    terminal?.dispose();
    terminal = undefined;
}

export function terminalStart(name: string, useVIA: boolean = false) {
    if(!terminal) {
        terminal = new Terminal(name, useVIA);
    } else {
        waiting = false;
        terminal.terminalClear();
    }
}

export function terminalWrite(char: string): void {
    terminal?.terminalWrite(char);
}

export function terminalRead(): string {
    const char = terminal?.terminalReadBuf();
    return char ? char : '';
}

export function terminalClear() {
    waiting = false;
    terminal?.terminalClear();
}

export function getcWaiting(): boolean {
    return waiting;
}
