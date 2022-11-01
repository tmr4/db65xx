import * as vscode from 'vscode';

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
    public constructor(name: string, useVIA: boolean = false) {
        this._terminal = this.terminalCreate(name, useVIA);
        this._lastChar = '';
        this._kbhit = false;
    }

    private terminalCreate(name: string, useVIA: boolean): vscode.Terminal {
        const pty = {
            onDidWrite: this._writeEmitter.event,
            open: () => this._writeEmitter.fire('VS Code 65816 Debugger\r\n\r\n'),
            close: () => { /* *** TODO: add 'end' event *** */ },
            handleInput: (data: string) => {
                if(useVIA) {
                    setLastChar(data);
                } else {
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
        this._writeEmitter.fire('\x1b[2J\x1b[3J\x1b[;H');
    }

    public terminalWrite(line: string): void {
        this._writeEmitter.fire(line);
        if(line === '\r') {
            this._writeEmitter.fire("\n");
        }
    }

    public terminalRead(): string {
        if(this._kbhit) {
            return this._lastChar;
        }
        return '';
    }

    public dispose() {
        this._terminal.dispose();
    }
}

var terminal: Terminal | undefined;

export function terminalDispose() {
    terminal?.dispose();
    terminal = undefined;
}

export function terminalStart(name: string, useVIA: boolean = false) {
    if(!terminal) {
        terminal = new Terminal(name, useVIA);
    }
}

export function terminalWrite(line: string): void {
    terminal?.terminalWrite(line);
}
