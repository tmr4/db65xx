/* eslint-disable @typescript-eslint/naming-convention */
// create a source/binary map from cc65 files

import * as fs from 'fs';
import { TextDecoder } from 'node:util';
import * as path from 'path';

import { readDebugFile, DbgMap, DbgScope, DbgSpan, DbgLine } from './dbgService';
import { Symbols, ISymbol } from './symbols';
import { Registers } from './registers';

interface IModule {
    name: string;
    segments: ISegment[];
}

interface ISegment {
    name: string;
    start: number;
}

interface ISegFile {
    name: string;
    file: string[];
}

interface IDefualtSegment {
    directive: string;
    name: string;
}

interface IModStart {
    segment: string
    segFile: string[]
    segBase: number
    segOffset: number
}

interface IGetSeg {
    segFile: string[]
    segBase: number
}

export interface ISourceMap {
    address: number;        // address associated with sourceLine
    fileId: number;         // file reference #
    instruction: string;    // text of instruction on line stripped of comments
    sourceLine: number;     // line number
}

export class SourceMap {
//    private symbolMap = new Map<string, ISymbol>(); // symbol/address pair
    private sourceMap = new Map<number, ISourceMap>(); // binary address/source mapping
    private reverseMap = new Map<number, Map<number, number | number[]>>(); // source line #/binnary address mapping
    public symbols: Symbols;
    public cSymbols = new Map<string, ISymbol>(); // c symbols by name;
    public cScopes = new Map<number, ISymbol[]>(); // c symbols by scope;
    public procedures = new Map<string, ISymbol>(); // assembly procedure/address pair;
    public functions = new Map<string, ISymbol>(); // C function/address pair;

    private sourceFiles: string[] = [];

    private modules: IModule[] = [];     // records map file modules and their associated segment/offset pairs
    private segments: ISegment[] = [];   // records map file segments and their associated start address
    private segFiles: ISegFile[] = [];   // stores temp file object for each segment

    public constructor(srcDir: string, listDir: string, basename: string, extension: string, memory: Uint8Array, registers: Registers) {
        let dbgFile = false;
        const file = path.join(listDir, basename + '.dbg');

        this.symbols = new Symbols(memory, registers);

        // try creating source and symbol maps with the ld65 debug file
        if (fs.existsSync(file)) {
            dbgFile = this.createMaps(file, srcDir, 2);
        }

        // that didn't work, try creating the maps with the listing, symbol and map files
        if (!dbgFile) {
            this.createSymbolMap(path.join(listDir, basename + '.sym'));
            this.createSourceMap(srcDir, listDir, basename, extension ? extension : ".s");
        }

        this.createReverseMap();
    }

    // returns the source map associated with this address
    public get(address: number): ISourceMap | undefined {
        return this.sourceMap.get(address);
    }

    // Return address associate with the source/line pair
    // (returns undefined if not a valid instruction)
    public getRev(sourceID: number, line: number): number | number[] | undefined {
        let address: number | number[] | undefined;
        const moduleMap = this.reverseMap.get(sourceID);

        if (moduleMap) {
            address = moduleMap.get(line);
        }

        return address;
    }

    public getSourceFile(index: number | undefined): string {
        if(index !== undefined) {
            return this.sourceFiles[index];
        } else {
            return '';
        }
    }

    public getSourceFiles(): string[] {
        return this.sourceFiles;
    }

    public getSourceId(source: string): number | undefined {
        const slc = source.toLowerCase();
        return this.sourceFiles.findIndex(file => file.toLowerCase() === slc);
    }

    // create source and symbol maps from ld65 debug file
    // returns true if successful, false if none of source files could be found
    // macroStep;   0 - don't step into macro source (UI remains at macro invocation while stepping through multi instruction macros)
    //              1 - step into macro source (even single instruction macro source; can be visually disruptive)
    //              2 - step into source of multi instruction macros after first instruction (first instruction executed at macro invocation)
    private createMaps(dbgFile: string, srcDir: string, macroStep: number): boolean {
        const dbgMap = readDebugFile(dbgFile);
        const sourceFiles: ISegFile[] = [];
        let fileCount = 0;

        // make a list of source files that exist
        for (const file of dbgMap.file) {
            const fileName = this.normalizePathAndCasing(file.name.slice(1, -1));

            if (fs.existsSync(fileName)) {
                const m = fs.readFileSync(fileName);
                sourceFiles.push({ name: fileName, file: new TextDecoder().decode(m).split(/\r?\n/) });
                this.sourceFiles.push(fileName);
                fileCount++;
            } else {
                sourceFiles.push({ name: '', file: [] });
                this.sourceFiles.push('');
            }
        }

        // fail if we couldn't locate any sources listed in the debug file
        if (fileCount === 0) {
            this.sourceFiles = [];
            return false;
        }

        for (const [index, sourceFile] of sourceFiles.entries()) {
            if (sourceFile.name.length > 0) {
                // line	id=0,file=0,line=25,span=11
                const lineSpans: DbgLine[] = dbgMap.line.filter((line) => {
                    return line.file === index && line.span ? line : undefined;
                });

                for (const line of lineSpans) {
                    const sourceLine = sourceFile.file[line.line - 1];
                    //if (line.span && !line.type) {
                    // assumbler or C sources
                    if (line.span && (!line.type || (line.type && line.type === 1))) {
                        for (const span of line.span) {
                            const address = spanToAddress(dbgMap, span);
                            const comIndex = sourceLine.indexOf(';'); // *** TODO: this can cut off part of a C line (for-loop for example) ***
                            const instruction = comIndex >= 0 ? sourceLine.substring(0, comIndex) : sourceLine;

                            this.sourceMap.set(address, {
                                address: address,
                                fileId: index,
                                instruction: instruction.trim(),
                                sourceLine: line.line,
                            });
                        }
                    }
                }
            }
        }

        // overwrite address/line map with any macro references
        // this will cause db65xx to show the macro source but
        // we'll not be able to break on macro name anymore
        for (const [index, sourceFile] of sourceFiles.entries()) {
            if (sourceFile.name.length > 0) {
                // line	id=0,file=0,line=25,span=11
                const lineSpans: DbgLine[] = dbgMap.line.filter((line) => {
                    return line.file === index && line.span ? line : undefined;
                });

                if (macroStep > 0) {
                    for (const line of lineSpans) {
                        const sourceLine = sourceFile.file[line.line - 1];
                        if (line.span && line.type && line.type === 2) {
                            for (const span of line.span) {
                                const address = spanToAddress(dbgMap, span);
                                const comIndex = sourceLine.indexOf(';');
                                const instruction = comIndex >= 0 ? sourceLine.substring(0, comIndex) : sourceLine;

                                // map this address according to macro stepping options
                                if ((macroStep === 1) || ((macroStep === 2) && (this.sourceMap.get(address) === undefined))) {
                                    this.sourceMap.set(address, {
                                        address: address,
                                        fileId: index,
                                        instruction: instruction.trim(),
                                        sourceLine: line.line,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        // assembly code symbol map
        for (const sym of dbgMap.sym) {
            // scope id=3,name="print_char",mod=0,type=scope,size=4,parent=0,sym=2,span=27
            // sym id=2,name="print_char",addrsize=absolute,size=4,scope=0,def=40,ref=19+51,val=0x802D,seg=0,type=lab
            const address = sym.val;
            if (address !== undefined) {
                const name = sym.name.slice(1, -1);
                const addr = parseInt(address, 16);
                const size = sym.size ? sym.size : 1;

                // *** TODO: decide whether to add to both procedures and symbols ***
                if (this.isScope(sym.name, dbgMap.scope)) {
                    this.procedures.set(name, { name: name, address: addr, size: size });
                } else {
                    this.symbols.set(name, { name: name, address: addr, size: size });
                }
            }
        }

        // C code symbol map
        for (const csym of dbgMap.csym) {
            // C function
            // csym	id=2,name="sieve",scope=1,type=0,sc=ext,sym=42
            // scope id=1,name="_sieve",mod=0,type=scope,size=405,parent=0,sym=42,span=193+192
            // sym id=42,name="_sieve",addrsize=absolute,size=405,scope=0,def=85,ref=6+270,val=0x80A3,seg=0,type=lab
            //
            // Local C variable
            // csym	id=7,name="i",scope=1,type=0,sc=auto,offs=-2
            const symb = csym.sym;
            const name = csym.name.slice(1, -1);

            if (symb !== undefined && !isNaN(symb)) {
                const address = dbgMap.sym[symb].val;
                const size = dbgMap.sym[symb].size;

                if (address !== undefined) {
                    const addr = parseInt(address, 16);

                    // *** TODO: decide whether to add to both functions and cSymbols ***
                    // *** TODO: probably need to ensure that scope symbol equals sym id ***
                    if (this.isScope('"_' + name + '"', dbgMap.scope)) {
                        this.functions.set(name, { name: name, address: addr, scope: csym.scope, size: size });
                    }
                }
            } else if (csym.sc === 'auto') {
                const offset = csym.offs ? csym.offs : 0;

                // look back to previous C symbol determine this symbol's size
                // For example, the debug file entry for:
                //   int count8(int a, int b)
                // csym id=53,name="count8",scope=13,type=0,sc=ext,sym=184
                // csym id=54,name="a",scope=13,type=0,sc=auto,offs=2
                // csym id=55,name="b",scope=13,type=0,sc=auto
                // csym id=56,name="n",scope=13,type=0,sc=auto,offs=-2
                // csym id=57,name="i",scope=13,type=0,sc=auto,offs=-3
                // csym id=58,name="j",scope=13,type=0,sc=auto,offs=-4
                //
                // and for:
                //   void count(void)
                // csym id=19,name="count",scope=5,type=0,sc=ext,sym=233
                // csym id=20,name="n",scope=5,type=0,sc=auto,offs=-1
                // csym id=21,name="i",scope=5,type=0,sc=auto,offs=-2
                // csym id=22,name="j",scope=5,type=0,sc=auto,offs=-3
                //
                // The byte at sp[0] appears to either be unused or used for passed params, so size is:
                //      local variable (offset < 0): previous offset - current offset
                //      parameter (offset >= 0):     same unless it's the first param
                // *** We can't determine the size of the first parameter from the debug file, assume 2 for now ***
                // The size of the first parameter can be determined using the stack pointer when the function
                // is first entered
                // *** Note that I didn't see any difference in the stack or debug file with the use of
                // __fastcall__ or __cdecl__, though the autogenerated code differed.  For now I'm treating them
                // the same for debugging purposes ***
                // *** See pages under https://github.com/cc65/wiki/wiki/ for some harder to find internal info
                // for example, https://github.com/cc65/wiki/wiki/Debug-info-data gives some good debug file information
                // and https://github.com/cc65/wiki/wiki/Parameter-passing-and-calling-conventions#the-fastcall-calling-convention
                // explains that __fastcall__ actually pushes the first parameter to the stack at the start of a function.
                // Interestingly this can be seen in debugging the C code.  With __fastcall__ you can set a breakpoint on
                // the opening brace of the function (where the push takes place), with __cdecl__, you can't. ***
                const pcsym = dbgMap.csym[csym.id - 1];
                const poffset = pcsym.offs ? pcsym.offs : 0;
                const csize = offset < 0 ? poffset - offset : (pcsym.sc === 'ext' ? 2 : poffset - offset);
                const sym = { name: name, scope: csym.scope, size: csize, offset: offset };
                let scopeSyms = this.cScopes.get(csym.scope);

                if (!scopeSyms) {
                    scopeSyms = new Array<ISymbol>();
                    this.cScopes.set(csym.scope, scopeSyms);
                }
                scopeSyms.push(sym);
                this.cSymbols.set(name, sym);
            }
        }

        return true;
    }

    private isScope(name: string, scopes: DbgScope[]): boolean {
        const iterator = scopes.entries();
        let entry = iterator.next();
        while (!entry.done) {
            const scope = entry.value[1];
            if (scope.name === name) {
                return true;
            }
            entry = iterator.next();
        }
        return false;
    }

    private createReverseMap() {
        this.sourceMap.forEach((sm, address) => {
            let rm = this.reverseMap.get(sm.fileId);
            if (!rm) {
                // add module to reverse map
                rm = new Map<number, number>;
                this.reverseMap.set(sm.fileId, rm);
            }
            const addr = rm.get(sm.sourceLine);
            if (typeof addr === 'number') {
                const addrA: number[] = [];
                addrA.push(addr);
                addrA.push(address);
                rm.set(sm.sourceLine, addrA);
            } else if (typeof addr === 'object') {
                addr.push(address);
                rm.set(sm.sourceLine, addr);
            } else {
                rm.set(sm.sourceLine, address);
            }
        });
    }

    // create symbol map from ld65 symbol table
    // typical ld65 VICE symbol table entry:
    // al 00F40A .KEYBOARD_BUFFER
    private createSymbolMap(file: string): void {
        // read map file and parse it into lines
        const m = fs.readFileSync(file);
        const lines = new TextDecoder().decode(m).split(/\r?\n/);

        // regular expression to parse this into address/symbol pair
        const reg0 = /(?:^al\s)([a-fA-F0-9]{6})(?:\s\.)(.*)/;

        for (let n = 0; n < lines.length; n++) {
            const line = lines[n];

            const match: RegExpExecArray | null = reg0.exec(line);
            if (match) {
                // save symbol
                // don't bother with local symbols
                if (!match[2].startsWith('@')) {
                    this.symbols.set(match[2], { name: match[2], address: parseInt(match[1], 16), size: 1 });
                }
            }
        }
    }

    // populate modules and segments from map_file
    private parse_map(map_file: string): void {
        // read map file and parse it into lines
        const m = fs.readFileSync(map_file);
        const lines = new TextDecoder().decode(m).split(/\r?\n/);

        let processing = '';
        let module_name = '';
        let module_segments: ISegment[] = [];
        const segs: string[] = [];   // temp segments

        // loop through map file capturing:
        //  1) modules and their associated segments/offsets
        //  2) segments and their associated starting address
        for (let n = 0; n < lines.length; n++) {
            const line = lines[n];

            if (processing === '') {
                const parse = line.split(' ');

                if (parse.length > 0) {
                    if (parse[0] === "Modules" && parse[1] === "list:") {
                        processing = "Modules";
                    }
                    else if (parse[0] === "Segment" && parse[1] === "list:") {
                        processing = "Segments";
                    }
                }
            }

            // capture segment/offset pairs in a module area
            if (processing === "Module") {
                if (line === '') {
                    // we're done parsing modules area
                    this.modules.push({ name: module_name, segments: module_segments });
                    processing = '';
                } else if (line[0] === " ") {
                    // a line with segment/offset pair
                    const seg = line.split(' ').filter(e => e !== '');
                    const offset = seg[1].split("=");
                    module_segments.push({ name: seg[0], start: parseInt(offset[1], 16) });

                    // note that segment is used if not included already
                    if (segs.filter(seg => seg === seg[0]).length === 0) {
                        segs.push(seg[0]);
                    }
                } else {
                    // a new module section
                    // save previous module's segment/offset pairs
                    // and get ready to process next module
                    this.modules.push({ name: module_name, segments: module_segments });
                    module_name = '';
                    module_segments = [];
                    processing = "Modules";
                }
            }

            // get name of next module
            if (processing === "Modules") {
                const pos = line.indexOf(".o:");
                if (pos >= 0) {
                    module_name = line.slice(0, pos);
                    processing = "Module";
                }
            }

            // capture all segments and their start addresses
            if (processing === "Segments") {
                if (line === '') {
                    processing = '';
                }
                else {
                    const seg = line.split(' ').filter(e => e !== '');
                    // ensure segment was listed in a module
                    if (segs.filter(s => s === seg[0]).length !== 0) {
                        // add segment/offset pair
                        this.segments.push({ name: seg[0], start: parseInt(seg[1], 16) });
                        this.segFiles.push({ name: seg[0], file: [] });
                    }
                }
            }
        }
    }

    private createSourceMap(srcDir: string, listDir: string, basename: string, extension: string) {
        const default_segments: IDefualtSegment[] = [
        { directive: ".bss", name: "BSS" },
        { directive: ".code", name: "CODE" },
        { directive: ".data", name: "DATA" },
        { directive: ".rodata", name: "RODATA" },
        { directive: ".zeropage", name: "ZEROPAGE" }];

        this.parse_map(path.join(listDir, basename + '.map'));

        // Regular expressions used to parse portions of listing line) {
        // Isolate segment directive and it's segment label
        const reg0 = /\.segment \"{1}.*[^\"]"/;
        const reg1 = /([^"]*)/;

        // parse line into) {
        //   relative address
        //   assembler code
        //   source stripped of comment
        // parse_line = re.compile(
        //    r'^([A-F0-9]{6})'               // relative address
        //    r'(?:r\s\d\s*)'                 // file reference (not captured)
        //    r'((?:[0-9A-Frx]{2}\s){0,4})'    // assembler code
        //    r'(?:\s*)'                      // whitespace (not captured)
        //    r'([A-z0-9@]+[:]+)?'            // optional line label and colon (not captured)
        //    r'(?:\s*)'                      // whitespace (not captured)
        //    r'([^;]*)'                      // source stripped of comment

        const reg3 = /^([A-F0-9]{6})(?:r\s\d\s*)((?:[0-9A-Frx]{2}\s){0,4})(?:\s*)([A-z0-9@]+[:]+)?(?:\s*)([^;]*)/;

        this.modules.forEach(module => {
            const file = path.join(listDir, module.name + ".lst"); // *** TODO: hardcoding extension here ***
            const m = fs.readFileSync(file);
            const lines = new TextDecoder().decode(m).split(/\r?\n/);
            let sline = 1;

            const smod = this.start_module(module);
            //let { seg_cur, seg_file, seg_base, seg_offset } = start_module(module)
            let seg_cur = smod.segment;
            let seg_file = smod.segFile;
            let seg_base = smod.segBase;
            let seg_offset = smod.segOffset;

            let seg = seg_cur;
            const macro = false;

            this.sourceFiles.push(path.join(srcDir, module.name + extension)); // *** TODO: hardcoding extension here ***
            for (let n = 0; n < lines.length; n++) {
                const line = lines[n];

                // macro labels need special handling when producing a clean listing
    //            if (args.c && !macro && line.indexOf(".macro") >= 0) {
    //                macro = true
    //            }
    //            else if (args.c && macro && line.indexOf(".endmacro") >= 0) {
    //                macro = false
    //            }
                if (line.length >= 9 && line[8] === '1') {
                    // parse line into relative address, assembler code and source line (label and comment excluded)
                    const match: RegExpExecArray | null = reg3.exec(line);
                    if (match) {
                        // we need source code w/o comments here to make sure any directive hasn't
                        // been commented out
                        const raddr = match[1];
                        const acode = match[2];
                        const label = match[3];
                        const s_source = match[4];

                        // evaluate whether this line changes the segment
                        const result = reg0.exec(s_source);

                        if (result === null) {
                            // check for a default segment directive
                            default_segments.forEach(segment => {
                                if (s_source.indexOf(segment.directive) >= 0) {
                                    seg = segment.name;
                                }
                            });
                        }
                        else {
                            // a .segment directive was found
                            const seg0 = s_source.split(reg1);
                            if (seg0 && seg0.length > 0) {
                                seg = seg0[3];
                            }
                        }

                        if (seg !== seg_cur) {
                            // line changes segment
                            // It's possible to change segments without laying down code
                            // in which case the segment may not appear in the map file.
                            // Try to change to this segment
                            const getSeg = this.get_seg(seg);
                            const getMod = module.segments.find(s => s.name === seg);
                            if (getSeg !== undefined && getMod !== undefined) {
                                seg_base = getSeg.segBase;
                                seg_file = getSeg.segFile;
                                seg_offset = getMod.start;
                                seg_cur = seg;
                            }
                            sline++;
                        }
                        else if (acode.length > 0 || line.slice(11, 22).indexOf("xx") >= 0) {
                            // convert relative address to absolute address
                            const addr = parseInt(raddr.slice(0, 6), 16) + seg_base + seg_offset;

                            // *** TODO: looks like we can do some consolidation here ***
                            if ((line.slice(11, 22).indexOf("xx") >= 0) || ((s_source.length > 0) && s_source.startsWith('.'))) {
                                if (label) {
                                    if (!line.includes(line.slice(24))) {
                                        //console.log("source and listing don't match at module/line: " + module.name + n.toString());
                                    }
                                    sline++;
                                    //const sym = this.symbolMap.get(label.slice(0, -1));
                                    const sym = this.symbols.get(label.slice(0, -1)); // *** TODO: is this doing what I think it is ***
                                    if (sym) {
                                        const dir = s_source.slice(1).split(' ');
                                        switch (dir[0]) {
                                            case 'word':
                                                sym.size = 2;
                                                break;
                                            case 'dword':
                                                sym.size = 4;
                                                break;
                                            case 'res':
                                                if (dir[1][0] === '$') {
                                                    sym.size = parseInt(dir[1].slice(1), 16);
                                                } else {
                                                    sym.size = parseInt(dir[1]);
                                                }
                                                break;
                                            case 'asciiz':
                                                const i = s_source.indexOf('"');
                                                const j = s_source.lastIndexOf('"');
                                                sym.size = s_source.slice(i + 1, j).length;
                                                break;
                                            case 'byte':
                                            default:
                                                break;
                                        }
                                    }
                                } else if (s_source.length > 0) {
                                    sline++;
                                }
                            } else {
                                if (s_source.length > 0) {
                                    if (!line.includes(line.slice(24))) {
                                        //console.log("source and listing don't match at module/line: " + module.name + n.toString());
                                    }

                                    this.sourceMap.set(addr, {
                                        address: addr,
                                        fileId: this.sourceFiles.length - 1,
                                        instruction: s_source.trim(),
                                        sourceLine: sline++,
                                    });
                                }
                            }
                        } else {
                            sline++;
                        }
                    }
                }
            }
        });

        // clean up
        this.modules = [];
        this.segments = [];
        this.segFiles = [];
    }

    // get module's default seg, seg_file, seg_base, seg_offset
    private start_module(module: IModule): IModStart {
        // CODE segment is default and is module's first
        // segment unless it doesn't have one
        // get module's first segment and offset
        const seg = module.segments[0].name;
        const seg_offset = module.segments[0].start;

        const getSeg = this.get_seg(seg);

        return { segment: seg, segFile: getSeg!.segFile, segBase: getSeg!.segBase, segOffset: seg_offset };
    }

    private get_seg(segName: string): IGetSeg | undefined {
        const seg_base = this.segments.find(seg => seg.name === segName)?.start;
        const seg_file = this.segFiles.find(seg => seg.name === segName)?.file;

        if (seg_base === undefined || seg_file === undefined) {
            return undefined;
        } else {
            return { segFile: seg_file, segBase: seg_base };
        }

    }

    private normalizePathAndCasing(path: string) {
        if (process.platform === 'win32') {
            return path.replace(/\//g, '\\').toLowerCase();
        } else {
            return path.replace(/\\/g, '/');
        }
    }
}

function spanToAddress(dbgMap: DbgMap, spanId: number): number {
    const span = dbgMap.span[spanId];

    return dbgMap.seg[span.seg].start + span.start;
}
