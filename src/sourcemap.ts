/* eslint-disable @typescript-eslint/naming-convention */
// create a source/binary map from cc65 files

import * as fs from 'fs';
import { TextDecoder } from 'node:util';
import * as path from 'path';

import { readDebugFile, DbgMap, DbgSpan, DbgLine } from './dbgService';

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
    address: number;
    fileId: number;
    instruction: string;
    sourceLine: number;
}

// *** TODO: consider adding file ID
// this isn't available from VICE symbol file
// but may be useful for identical symbols in
// different source files.  I think the dbgfile
// has this covered and referencing file here isn't needed. ***
interface ISymbol {
    address: number;
    size: number;       // size in bytes
//    fileId: number;
}

export class SourceMap {
    private symbolMap = new Map<string, ISymbol>(); // symbol/address pair
    private sourceMap = new Map<number, ISourceMap>(); // binary address/source mapping
    private reverseMap = new Map<number, Map<number, number>>(); // source line #/binnary address mapping

    private sourceFiles: string[] = [];

    private modules: IModule[] = [];     // records map file modules and their associated segment/offset pairs
    private segments: ISegment[] = [];   // recodes map file segments and their associated start address
    private segFiles: ISegFile[] = [];   // stores temp file object for each segment

    public constructor(srcDir: string, listDir: string, basename: string, extension: string) {
        let dbgFile = false;
        const file = path.join(listDir, basename + '.dbg');

        // try creating source and symbol maps with the ld65 debug file
        if (fs.existsSync(file)) {
            dbgFile = this.createMaps(file);
        }

        // that didn't work, try creating the maps with the listing, symbol and map files
        if (!dbgFile) {
            this.createSymbolMap(path.join(listDir, basename + '.sym'));
            this.createSourceMap(srcDir, listDir, basename, extension);
        }

        this.createReverseMap();
    }

    // returns the source map associated with this address
    public get(address: number): ISourceMap | undefined {
        return this.sourceMap.get(address);
    }

    // Return address associate with the source/line pair
    // (returns undefined if not a valid instruction)
    public getRev(sourceID: number, line: number): number | undefined {
        let address: number | undefined;
        const moduleMap = this.reverseMap.get(sourceID);

        if (moduleMap) {
            address = moduleMap.get(line);
        }

        return address;
    }

    public getSymbol(symbol: string): ISymbol | undefined {
        return this.symbolMap.get(symbol);
    }

    public getSymbolAddress(symbol: string): number | undefined {
        return this.symbolMap.get(symbol)?.address;
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
    // returns true if successful, false if any of the source files couldn't be found
    private createMaps(dbgFile: string): boolean {
        const dbgMap = readDebugFile(dbgFile);

        const sourceFiles: ISegFile[] = [];
        for (const file of dbgMap.file) {
            const fileName = file.name.slice(1, -1);
            if (fs.existsSync(fileName)) {
                const m = fs.readFileSync(fileName);
                sourceFiles.push({ name: fileName, file: new TextDecoder().decode(m).split(/\r?\n/) });
                this.sourceFiles.push(fileName);
            } else {
                this.sourceFiles = [];
                return false;
            }
        }

        for (const [index, sourceFile] of sourceFiles.entries()) {
            // line	id=0,file=0,line=25,span=11
            const lineSpans: DbgLine[] = dbgMap.line.filter( (line) => {
                return line.file === index && line.span ? line : undefined;
            });

            for ( const line of lineSpans) {
                const sourceLine = sourceFile.file[line.line - 1];
                if(line.span && !line.type) {
                    const address = spanToAddress(dbgMap, line.span[0]);
                    const comIndex = sourceLine.indexOf(';');
                    const instruction = comIndex >= 0 ? sourceLine.substring(0, comIndex) : sourceLine;

                    this.sourceMap.set(address, {
                        address: address,
                        fileId: index,
                        instruction: instruction.trim(),
                        sourceLine: line.line,
                    });
                }
            }

            for (const sym of dbgMap.sym) {
                // sym	id=0,name="print_char",addrsize=absolute,scope=0,def=9,ref=21,val=0x8014,seg=0,type=lab
                const address = sym.val;
                if (address) {
                    this.symbolMap.set(sym.name.slice(1, -1), { address: parseInt(address, 16), size: sym.size ? sym.size : 1 });
                }
            }
        }

        return true;
    }

    private createReverseMap() {
        this.sourceMap.forEach((sm, address) => {
            let rm = this.reverseMap.get(sm.fileId);
            if (!rm) {
                // add module to reverse map
                rm = new Map<number, number>;
                this.reverseMap.set(sm.fileId, rm);
            }
            rm.set(sm.sourceLine, address);
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
                    this.symbolMap.set(match[2], { address: parseInt(match[1], 16), size: 1 });
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
                                    const sym = this.symbolMap.get(label.slice(0, -1));
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
}

function spanToAddress(dbgMap: DbgMap, spanId: number): number {
    const span = dbgMap.span[spanId];

    return dbgMap.seg[span.seg].start + span.start;
}
