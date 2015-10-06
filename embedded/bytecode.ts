///<reference path='refs.ts'/>

module TDev.AST.Bytecode
{
    interface FuncInfo {
        type: string;
        args: number;
        idx: number;
    }

    interface OpcodeInfo {
        stack: number;
        idx: number;
    }

    var opcodeInfo:StringMap<OpcodeInfo>;
    var funcInfo:StringMap<FuncInfo>;
    var hex:string[];

    function setup()
    {
        var inf = (<any>TDev).bytecodeInfo
        opcodeInfo = inf.opcodes;
        funcInfo = inf.functions;
        hex = inf.hex;
    }

    function isRefKind(k:Kind)
    {
        Util.assert(k != null)
        Util.assert(k != api.core.Unknown)
        var isSimple = k == api.core.Number || k == api.core.Boolean
        return !isSimple
    }

    function isRefExpr(e:Expr)
    {
        if (typeof e.getLiteral() == "string" && e.enumVal != null)
            return false;
        if (typeof e.getLiteral() == "number")
            return false;
        return isRefKind(e.getKind())
    }

    function lookupFunc(name:string)
    {
        if (/^uBit\./.test(name))
            name = name.replace(/^uBit\./, "micro_bit::").replace(/\.(.)/g, (x, y) => y.toUpperCase())
        return funcInfo[name]
    }


    export class Opcode
    {
        arg0:any;
        arg1:number;
        index:number;
        info:string;

        constructor(public name:string, public code:number)
        {
        }

        size()
        {
            if (this.name == "BL")
                return 2;

            if (this.name == "LDPTR")
                return 4;

            if (this.name == "LABEL")
                return 0;

            if (this.code)
                return 1;

            Util.oops("cannot compute size: " + this.name)
        }

        emitTo(bin:Binary)
        {
            //TODO
            if (!this.info) {
                if (typeof this.arg0 == "string")
                    this.info = JSON.stringify(this.arg0)
                else if (typeof this.arg0 == "number")
                    this.info = this.arg0 + ""
                else this.info = "";
            }

            if (this.info.length > 60)
                this.info = this.info.slice(0, 60) + "..."

            bin.comment("0x" + this.index.toString(16) + ": " + this.name + " " + this.darg + (this.info ? " " + this.info : ""));

            if (this.name == "LABEL")
                return;

            var inf = opcodeInfo[this.name]

            Util.assert(0 <= this.darg && this.darg <= 255)

            bin.push(inf.idx | ((this.darg & 0xff) << 8))

            if (this.arg0 == null) return
            if (this.arg0 instanceof Opcode)
                bin.push((<Opcode>this.arg0).index)
            else if (this.arg0 instanceof Procedure)
                bin.push((<Procedure>this.arg0).index)
            else if (typeof this.arg0 == "number")
                bin.push(this.arg0)
            else if (typeof this.arg0 == "string") {
                Util.assert(!!bin.strings[this.arg0])
                bin.push(bin.strings[this.arg0])
            } else Util.oops("bad arg0: " + this.arg0)

            if (this.arg1 == null) return
            if (typeof this.arg1 == "number")
                bin.push(this.arg1)
            else Util.oops("bad arg1: " + this.arg1)
        }

        stackOffset()
        {
            if (/^pop\s*\{r[0-9]\}/.test(this.name))
                return -1;
            if (/^push\s*\{r[0-9]\}/.test(this.name))
                return 1;

            return 0;
        }
    }

    export class Location
    {
        isarg = false;

        constructor(public index:number, public def:Decl = null)
        {
        }

        isRef()
        {
            return this.def && isRefKind(this.def.getKind())
        }

        emitStore(proc:Procedure)
        {
            if (this.isarg)
                Util.oops("store for arg")

            if (this.def instanceof GlobalDef) {
                proc.emitInt(this.index)
                proc.emitCall("bitvm::stglb" + (this.isRef() ? "Ref" : ""), 0); // unref internal
            } else {
                proc.emit("pop {r0}", 0xbc01);
                var op = proc.emit("STR", 0x9000)
                op.arg0 = this
                op.arg1 = proc.currStack
            }
        }

        emitLoad(proc:Procedure)
        {
            if (this.def instanceof GlobalDef) {
                proc.emitInt(this.index)
                proc.emitCall("bitvm::ldglb" + (this.isRef() ? "Ref" : ""), 0); // unref internal
            } else {
                var op = proc.emit("LDR", 0x9800)
                op.arg0 = this
                op.arg1 = proc.currStack
                proc.emit("push {r0}", 0xb401);
                if (this.isRef())
                    proc.emitCall("bitvm::incr", 0);
            }
        }

        emitClrIfRef(proc:Procedure)
        {
            // Util.assert(!this.isarg)
            Util.assert(!(this.def instanceof GlobalDef))
            if (this.isRef()) {
                var op = proc.emit("LDR", 0x9800)
                op.arg0 = this
                op.arg1 = proc.currStack
                proc.emitCall("bitvm::decr", 0);
            }
        }
    }

    export class Procedure
    {
        numArgs = 0;
        hasReturn = false;
        currStack = 0;
        maxStack = 0;
        action:Action;

        body:Opcode[] = [];
        locals:Location[] = [];
        args:Location[] = [];
        index:number;

        mkLocal(def:LocalDef = null)
        {
            var l = new Location(this.locals.length, def)
            this.locals.push(l)
            return l
        }

        size(idx:number)
        {
            this.expandOpcodes();
            this.index = idx;
            idx += 3;
            this.body.forEach(o => {
                o.index = idx;
                idx += o.size();
            })
            return idx - this.index;
        }

        expandOpcodes()
        {
            var res:Opcode[] = []
            this.body.forEach(op => {
                if (op.name == "LOCALS") {
                    if (this.locals.length > 0) {
                        res.push(new Opcode("movs r0, #0", 0x2000))
                        this.locals.forEach(l => {
                            res.push(new Opcode("push {r0}",  0xb401))
                        })
                    }
                    return // don't copy
                } else if (op.name == "LDR" || op.name == "STR") {
                    Util.assert(!!op.code)
                    var l:Location = op.arg0
                    var idx = (l.isarg ? this.locals.length : 0) + l.index + op.arg1
                    Util.assert(0 <= idx && idx < 255);
                    op.name = op.name.toLowerCase() + " r0, [sp, #4*" + idx + "]"
                    op.code |= idx
                } else if (op.name == "B") {
                } else if (op.name == "BL") {
                } else if (op.name == "LDPTR") {
                } else if (op.name == "LABEL") {
                    // do nothing
                } else if (/^[a-z]/.test(op.name)) {
                    // expanded
                } else {
                    Util.oops("unknown opcode macro: " + op.name)
                }
                res.push(op)
            })
            this.body = res
        }

        emitCall(name:string, mask:number)
        {
            var inf = lookupFunc(name)
            Util.assert(!!inf, "unimplemented function: " + name)

            Util.assert(inf.args <= 4)

            if (inf.args >= 4)
                this.emit("pop {r3}",  0xbc08);
            if (inf.args >= 3)
                this.emit("pop {r2}",  0xbc04);
            if (inf.args >= 2)
                this.emit("pop {r1}",  0xbc02);
            if (inf.args >= 1)
                this.emit("pop {r0}",  0xbc01);

            var numMask = 0

            if (inf.type == "F" && mask != 0) {
                // reserve space for return val
                this.emit("push {r0}",  0xb401);
            }

            if (mask & (1 << 0)) {
                numMask++
                this.emit("push {r0}",  0xb401);
            }
            if (mask & (1 << 1)) {
                numMask++
                this.emit("push {r1}",  0xb402);
            }
            if (mask & (1 << 2)) {
                numMask++
                this.emit("push {r2}",  0xb404);
            }
            if (mask & (1 << 3)) {
                numMask++
                this.emit("push {r3}",  0xb408);
            }

            Util.assert((mask & ~0xf) == 0)

            var op = this.emit("BL", 0)
            op.info = name;
            op.arg0 = inf;

            if (inf.type == "F") {
                if (mask == 0)
                    this.emit("push {r0}",  0xb401);
                else {
                    this.emit("str r0, [sp, #4*" + numMask + "]", 0x9000 | numMask)
                }
            }
            else if (inf.type == "P") {
                // ok
            }
            else Util.oops("invalid call type " + inf.type)

            while (numMask-- > 0) {
                this.emitCall("bitvm::decr", 0);
            }
        }

        emitTo(bin:Binary)
        {
            //TODO
            bin.comment("\n\n// 0x" + this.index.toString(16) + ": FUNC " + (this.action ? this.action.getName() : "(inline)"))
            bin.push(0x4201);
            bin.push(this.locals.length);
            bin.push(this.maxStack);
            this.body.forEach(o => o.emitTo(bin))
        }

        emitJmp(trg:Opcode, name = "JMP"):Opcode
        {
            if (name == "JMPZ") {
                this.emit("bne +2", 0xd100)
            } else if (name == "JMP") {
                // ok
            } else {
                Util.oops("bad jmp");
            }

            var op = this.emit("B", 0xe000); // 0b11100<op>
            op.arg0 = trg
            return op
        }

        mkLabel():Opcode
        {
            return new Opcode("LABEL", 0)
        }

        emitLbl(op:Opcode)
        {
            Util.assert(op.name == "LABEL")
            this.body.push(op)
        }

        emit(name:string, code:number):Opcode
        {
            var op = new Opcode(name, code)
            this.currStack += op.stackOffset();
            Util.assert(this.currStack >= 0);
            if (this.currStack > this.maxStack)
                this.maxStack = this.currStack;
            this.body.push(op)
            return op
        }
    }

    export class Binary
    {
        procs:Procedure[] = [];
        globals:Location[] = [];
        buf:number[] = [];
        csource = "";

        stringSeq:StringMap<number> = {};
        nextStringId = 0;
        strings:StringMap<number> = {};

        isDataRecord(s:string)
        {
            if (!s) return false
            var m = /^:......(..)/.exec(s)
            Util.assert(!!m)
            return m[1] == "00"
        }

        patchHex(shortForm:boolean)
        {
            var myhex = hex.slice(0)

            var i = 0;
            for (; i < myhex.length; ++i) {
                if (/^:10....000108010842424242010801083ED8E98D/.test(myhex[i]))
                    break;
            }

            Util.assert(i < myhex.length)
            var i0 = i;
            var ptr = 0
            var togo = 32000 / 8;
            while (ptr < this.buf.length) {
                if (myhex[i] == null) Util.die();
                var m = /^:10(..)(..)00(.*)(..)$/.exec(myhex[i])
                if (!m) { i++; continue; }
                Util.assert(i == i0 || /^0+$/.test(m[3]))


                var bytes = [0x10, parseInt(m[1], 16), parseInt(m[2], 16), 0]
                for (var j = 0; j < 8; ++j) {
                    bytes.push((this.buf[ptr] || 0) & 0xff)
                    bytes.push((this.buf[ptr] || 0) >>> 8)
                    ptr++
                }

                var chk = 0
                var r = ":"
                bytes.forEach(b => chk += b)
                bytes.push((-chk) & 0xff)
                bytes.forEach(b => r += ("0" + b.toString(16)).slice(-2))
                myhex[i] = r.toUpperCase();
                i++;
                togo--;
            }

            if (shortForm) {
                for (var j = 0; j < myhex.length; ++j) {
                    if (!(i0 <= j && j <= i) && this.isDataRecord(myhex[j]))
                        myhex[j] = "";
                }
            } else {
                while (togo > 0) {
                    if (myhex[i] == null) Util.die();
                    var m = /^:10(..)(..)00(.*)(..)$/.exec(myhex[i])
                    if (!m) { i++; continue; }
                    Util.assert(/^0+$/.test(m[3]))
                    myhex[i] = "";
                    i++;
                    togo--;
                }
            }

            return myhex.filter(l => !!l);
        }

        emitString(s:string, needsSeqId = true):number
        {
            this.strings[s] = 0;
            if (needsSeqId) {
                if (!this.stringSeq.hasOwnProperty(s))
                    this.stringSeq[s] = this.nextStringId++;
                return this.stringSeq[s];
            } else return -1;
        }

        comment(s:string)
        {
            this.csource += "\n// " + s + "\n"
        }

        push(n:number)
        {
            this.buf.push(n)
            this.csource += "0x" + ("000" + n.toString(16)).slice(-4) + ", "
        }

        serialize()
        {
            // TODO
            Util.assert(this.csource == "");

            this.comment("start");
            this.push(0x4202);
            this.push(this.globals.length);
            this.push(this.nextStringId);
            this.push(0); // future use
            this.push(0);
            this.push(0);

            var idx = this.buf.length;
            this.procs.forEach(p => {
                idx += p.size(idx);
            })
            Object.keys(this.strings).forEach(s => {
                this.strings[s] = idx;
                idx += Math.ceil((s.length + 1) / 2)
            })
            this.procs.forEach(p => {
                Util.assert(this.buf.length == p.index);
                p.emitTo(this);
            })
            function byteAt(s, i) { return (s.charCodeAt(i) || 0) & 0xff }
            Object.keys(this.strings).forEach(s => {
                Util.assert(this.buf.length == this.strings[s]);
                var len = Math.ceil((s.length + 1) / 2)
                this.comment("String: " + JSON.stringify(s))
                for (var i = 0; i < len; ++i) {
                    this.push( (byteAt(s, i*2+1) << 8) | byteAt(s, i*2) )
                }
            })
        }
    }

    export class ReachabilityVisitor
        extends PreCompiler
    {
        useAction(a:Action)
        {
            if (/{shim:.*}/.test(a.getDescription()))
                return
            super.useAction(a)
        }
    }

    export class Compiler
        extends NodeVisitor 
    {
        public binary = new Binary();
        private proc:Procedure;

        constructor(private app:App)
        {
            super()
        }

        private shouldCompile(d:Decl)
        {
            return d.visitorState === true;
        }

        private run()
        {
            setup();
            var pre = new ReachabilityVisitor({});
            pre.run(this.app)

            this.app.librariesAndThis().forEach(l => {
                if (l.isThis()) {
                    l.resolved.libraries().forEach(lr => 
                        lr.getPublicActions().forEach((la : LibraryRefAction) => {
                            la._compilerInfo = la.template
                        }))
                } else {
                    var ress = Util.toDictionary(<ResolveClause[]>l.resolveClauses.stmts, r => r.formalLib.getName())
                    l.resolved.libraries().forEach(lr => {
                        var acts = Util.toDictionary(<ActionBinding[]>ress[lr.getName()].actionBindings.stmts, a => a.formal.getName())
                        lr.getPublicActions().forEach((la : LibraryRefAction) => {
                            if (!acts[la.getName()]) return
                            var act = acts[la.getName()].actual
                            if (act instanceof LibraryRefAction && (<LibraryRefAction>act).template)
                                la._compilerInfo = (<LibraryRefAction>act).template
                            else
                                la._compilerInfo = act
                        })
                    })
                }
                this.prepApp(l.resolved)
            })

            this.app.librariesAndThis().forEach(l => {
                this.compileApp(l.resolved)
            })

            while (this.finals.length > 0) {
                var f = this.finals.shift()
                f()
            }
        }

        public compile(shortForm:boolean)
        {
            shortForm = false; // this doesn't work yet

            this.run()
            this.binary.serialize()
            var hex = this.binary.patchHex(shortForm).join("\r\n") + "\r\n"
            var r = 
                "#include \"BitVM.h\"\n" +
                "namespace bitvm {\n" +
                "const uint16_t bytecode[32000] __attribute__((aligned(0x20))) = {\n" + 
                this.binary.csource + "\n}; }\n"
            return {
                dataurl: "data:application/x-microbit-hex;base64," + Util.base64Encode(hex),
                csource: r
            }
        }

        visitAstNode(n:AstNode)
        {
            this.visitChildren(n);
        }

        handleAssignment(e:Call)
        {
            Util.assert(e._assignmentInfo.targets.length == 1)
            var trg = e.args[0]
            var src = e.args[1]
            var refSuff = isRefKind(e.args[1].getKind()) ? "Ref" : ""

            if (trg.referencedRecordField()) {
                this.dispatch((<Call>trg).args[0])
                this.emitInt(this.fieldIndex(trg.referencedRecordField()))
                this.dispatch(src)
                this.proc.emitCall("bitvm::stfld" + refSuff, 0); // it does the decr itself, no mask
            } else if (trg.referencedData()) {
                this.dispatch(src);
                this.globalIndex(trg.referencedData()).emitStore(this.proc);
            } else if (trg.referencedLocal()) {
                this.dispatch(src);
                this.localIndex(trg.referencedLocal()).emitStore(this.proc);
            } else {
                Util.oops("bad assignment: " + trg.nodeType())
            }
        }

        visitBreak(b:Call)
        {
            this.proc.emitJmp(b.topAffectedStmt._compilerBreakLabel);
        }

        visitContinue(b:Call)
        {
            this.proc.emitJmp(b.topAffectedStmt._compilerContinueLabel);
        }

        visitReturn(r:Call)
        {
            if (r.topRetLocal) {
                this.dispatch(r.args[0]);
                this.localIndex(r.topRetLocal).emitStore(this.proc);
            }
            this.proc.emitJmp(r.topAffectedStmt._compilerBreakLabel)
        }

        getMask(args:Expr[])
        {
            Util.assert(args.length <= 8)
            var m = 0
            args.forEach((a, i) => {
                if (isRefExpr(a))
                    m |= (1 << i)
            })
            return m
        }

        emitAsString(e:Expr)
        {
            this.dispatch(e)
            var kn = e.getKind().getName().toLowerCase()
            if (kn == "string") {}
            else if (kn == "number" || kn == "boolean") {
                this.proc.emitCall(kn + "::to_string", 0)
            } else {
                Util.oops("don't know how to convert " + kn + " to string")
            }
        }

        emitImageLiteral(s:string)
        {
            if (!s)
                s = "0 0 0 0 0\n0 0 0 0 0\n0 0 0 0 0\n0 0 0 0 0\n0 0 0 0 0\n";

            var x = 0;
            var w = 0;
            var h = 0;
            var lit = "";
            for (var i = 0; i < s.length; ++i) {
                switch (s[i]) {
                case "0": lit += "\u0000"; x++; break;
                case "1": lit += "\u0001"; x++; break;
                case " ": break;
                case "\n":
                    if (w == 0)
                        w = x;
                    else if (x != w)
                        // Sanity check
                        throw new Error("Malformed string literal");
                    x = 0;
                    h++;
                    break;
                default:
                    throw new Error("Malformed string literal");
                }
            }

            if (x > 0) h++; // non-terminated last line

            this.emitInt(w);
            this.emitInt(h);
            var op = this.proc.emit("LDPTR");
            op.arg0 = lit;
            this.proc.emit("push {r0}", 0xb401);
            this.binary.emitString(lit, false);
        }

        handleActionCall(e:Call)
        {
            var aa = e.calledExtensionAction() || e.calledAction()
            var args = e.args.slice(0)
            if (args[0].getKind() instanceof ThingSetKind || 
                args[0].referencedLibrary() || 
                (args[0] instanceof ThingRef && (<ThingRef>args[0]).namespaceLibraryName())) 
            {

                args.shift()
            }

            Util.assert(args.length == aa.getInParameters().length)

            var a:Action = aa._compilerInfo || aa
            var shm = /{shim:([^{}]*)}/.exec(a.getDescription())
            var hasret = !!aa.getOutParameters()[0]

            if (shm && shm[1] == "TD_NOOP") {
                Util.assert(!hasret)
                return
            }

            if (shm && /^micro_bit::(createImage|showAnimation|plotImage)$/.test(shm[1])) {
                Util.assert(args[0].getLiteral() != null)
                this.emitImageLiteral(args[0].getLiteral())
                args.shift()
                args.forEach(a => this.dispatch(a))
                // fake it, so we don't get assert down below and mask is correct
                args = [<Expr>mkLit(0), mkLit(0), mkLit(0)].concat(args)
            } else {
                args.forEach(a => this.dispatch(a))
            }


            if (shm) {
                var mask = this.getMask(args)
                var msg = "{shim:" + shm[1] + "} from " + a.getName()
                if (!shm[1])
                    Util.oops("called " + msg)

                var inf = lookupFunc(shm[1])

                if (!inf)
                    Util.oops("no such " + msg)

                if (!hasret) {
                    Util.assert(inf.type == "P", "expecting procedure for " + msg);
                } else {
                    Util.assert(inf.type == "F", "expecting function for " + msg);
                }
                Util.assert(args.length == inf.args, "argument number mismatch: " + args.length + " vs " + inf.args + " in " + msg)

                this.proc.emitCall(shm[1], mask)
            } else {
                var op = this.proc.emit("BL", 0)
                op.arg0 = this.procIndex(a);
                op.info = a.getName()
                Util.assert(!!op.arg0)
            }
        }

        visitCall(e:Call)
        {
            var p = e.getCalledProperty()
           
            if (p == api.core.AssignmentProp) {
                this.handleAssignment(e)
                return
            }

            var emitCall = (name:string, args:Expr[]) => {
                args.forEach(a => this.dispatch(a))
                this.proc.emitCall(name, this.getMask(args));
            }

            var pkn = p.parentKind.getRoot().getName()

            if (p.parentKind.getRoot() == api.core.Collection &&
                isRefKind(p.parentKind.getParameter(0)))
                pkn = "RefCollection";

            if (e.args.length == 1 && p.getName() == "is invalid") {
                this.dispatch(e.args[0])
                this.proc.emit("ISNULL")
            } else if (e.referencedData()) {
                this.globalIndex(e.referencedData()).emitLoad(this.proc)
            } else if (e.referencedLibrary()) {
                // TODO
            } else if (e.args[0] && e.args[0].referencedRecord()) {
                var rrec = e.args[0].referencedRecord()
                if (p.getName() == "create") {
                    this.emitInt(rrec._compilerInfo.refsize);
                    this.emitInt(rrec._compilerInfo.size);
                    this.proc.emitCall("record::mk", 0);
                } else if (p.getName() == "invalid") {
                    this.proc.emit("LDZERO")
                } else {
                    Util.oops("unhandled record operation: " + p.getName())
                }
            } else if (e.referencedRecordField()) {
                this.dispatch(e.args[0])
                this.proc.emit("LDFLD" + (isRefKind(e.getKind()) ? "REF" : ""), 
                               this.fieldIndex(e.referencedRecordField()))
            } else if (p.parentKind instanceof RecordEntryKind) {
                if (p.getName() == "equals") {
                    emitCall("number::eq", e.args)
                } else {
                    Util.oops("unhandled entry record operation: " + p.getName())
                }
            } else if (e.calledAction() || e.calledExtensionAction()) {
                this.handleActionCall(e);
            } else if (pkn == "Invalid") {
                this.proc.emit("LDZERO")
            } else if ((e.getKind().getRoot() == api.core.Collection && e.args[0].getCalledProperty() &&
                        e.args[0].getCalledProperty().getName() == "Collection of")) {
                this.proc.emitCall(isRefKind(e.getKind().getParameter(0)) ? "refcollection::mk" : "collection::mk", 0);
            } else if (p == api.core.StringConcatProp) {
                this.emitAsString(e.args[0]);
                this.emitAsString(e.args[1]);
                this.proc.emitCall("string::concat_op", 3);
            } else {
                var args = e.args.slice(0)
                if (args[0].getThing() instanceof SingletonDef)
                    args.shift()
                var nm = pkn.toLowerCase() + "::" + Embedded.Helpers.mangle(p.getName())
                var inf = lookupFunc(nm)
                if (!inf) {
                    nm = pkn.toLowerCase() + "::" + p.runtimeName()
                    inf = lookupFunc(nm)
                }

                if (nm == "contract::assert") {
                    Util.assert(typeof args[1].getLiteral() == "string")
                    this.dispatch(args[0])
                    var op = this.proc.emit("LDPTR");
                    op.arg0 = args[1].getLiteral()
                    this.binary.emitString(op.arg0, false)
                    this.proc.emitCall(nm, 0)
                    return
                }

                if (inf) {
                    if (e.getKind() == api.core.Nothing) {
                        Util.assert(inf.type == "P", "expecting procedure for " + nm);
                    } else {
                        Util.assert(inf.type == "F", "expecting function for " + nm);
                    }
                    Util.assert(args.length == inf.args, "argument number mismatch: " + args.length + " vs " + inf.args)
                    emitCall(nm, args);
                } else {
                    Util.oops("function not found: " + nm)
                }
            }
        }

        visitExprHolder(eh:ExprHolder)
        {
            if (eh.isPlaceholder())
                this.proc.emit("NOOP");
            else
                this.dispatch(eh.parsed)
        }

        emitInt(v:number)
        {
            Util.assert(v != null);

            var n = Math.floor(v)
            var isNeg = false
            if (n < 0) {
                isNeg = true
                n = -n
            }

            if (n == 0)
                this.proc.emit("LDZERO")
            else if (n <= 255)
                this.proc.emit("LDCONST8", n)
            else if (n <= 0xffff) {
                var op = this.proc.emit("LDCONST16");
                op.arg0 = n
            } else {
                var op = this.proc.emit("LDCONST32");
                op.arg0 = n & 0xffff
                op.arg1 = (n >>> 16) & 0xffff
            }
            if (isNeg)
                this.proc.emit("NEG");
        }

        visitLiteral(l:Literal)
        {
            if (l.data === undefined) return
            if (typeof l.data == "number") {
                this.emitInt(l.data)
            } else if (typeof l.data == "string") {
                if (l.enumVal != null) {
                    if (/^-?\d+$/.test(l.enumVal)) {
                        this.emitInt(parseInt(l.enumVal))
                    } else {
                        var inf = lookupFunc(l.enumVal)
                        if (!inf)
                            Util.oops("unhandled enum val: " + l.enumVal)
                        if (inf.type == "E")
                            this.proc.emit("LDENUM", inf.idx)
                        else if (inf.type == "F" && inf.args == 0)
                            this.proc.emitCall(l.enumVal, 0)
                        else
                            Util.oops("not valid enum: " + l.enumVal)
                    }
                } else if (l.data == "") {
                    this.proc.emitCall("string::mkEmpty", 0);
                } else {
                    var id = this.binary.emitString(l.data)
                    var op = this.proc.emit("LDSTRREF", id);
                    op.arg0 = l.data
                }
            }
            else if (typeof l.data == "boolean") {
                this.proc.emit("LDCONST8", l.data ? 1 : 0)
            }
            else {
                Util.oops("invalid literal emit " + l.data) // TODO
            }
        }

        private finals:(()=>void)[] = [];

        emitInlineAction(inl:InlineAction)
        {
            var locs = AST.Compiler.computeCapturedLocals(inl);
            var inlproc = new Procedure()
            this.binary.procs.push(inlproc);

            var refs  = locs.capturedLocals.filter(l => isRefKind(l.getKind()))
            var flats = locs.capturedLocals.filter(l => !isRefKind(l.getKind()))

            var caps = refs.concat(flats)

            this.emitInt(refs.length)
            this.emitInt(caps.length)
            var op = this.proc.emit("LDCONST16")
            op.arg0 = inlproc
            this.proc.emitCall("action::mk", 0)

            caps.forEach((l, i) => {
                this.localIndex(l).emitLoad(this.proc)
                this.proc.emit("STCLO", i)
            })

            Util.assert(inl.inParameters.length == 0)

            this.finals.push(() => {
                this.proc = inlproc

                this.proc.args = caps.map((p, i) => {
                    var l = new Location(i, p);
                    l.isarg = true
                    return l
                })

                locs.allLocals.forEach(l => {
                    l._lastWriteLocation = null;
                    if (caps.indexOf(l) == -1)
                        this.proc.mkLocal(l)
                })

                var ret = this.proc.mkLabel()
                inl._compilerBreakLabel = ret;
                this.dispatch(inl.body);
                this.proc.emitLbl(ret)

                Util.assert(this.proc.currStack == 0)

                this.proc.emitClrs(null)
                this.proc.emit("RET0")
            })
        }

        visitThingRef(t:ThingRef)
        {
            var d = t.def
            if (d instanceof LocalDef) {
                if (d._lastWriteLocation instanceof InlineAction) {
                    this.emitInlineAction(<InlineAction>d._lastWriteLocation)
                } else {
                    this.localIndex(d).emitLoad(this.proc);
                }
            } else if (d instanceof SingletonDef) {
                // nothing
            }
            else {
                Util.oops("invalid thing: " + d ? d.nodeType() : "(null)")
            }
        }

        visitAnyIf(i:If)
        {
            if (i.isTopCommentedOut())
                return

            if (!i.branches)
                return

            i.branches.forEach((b, k) => {
                if (!b.condition) {
                    this.dispatch(b.body)
                } else {
                    this.dispatch(b.condition)
                    var fwd = this.proc.emit("JMPZ");
                    this.dispatch(b.body)
                    fwd.arg0 = this.proc.emit("LABEL");
                }
            })
        }

        globalIndex(l:GlobalDef):Location
        {
            return this.binary.globals.filter(n => n.def == l)[0]
        }

        fieldIndex(l:RecordField):number
        {
            Util.assert(l._compilerInfo.idx != null);
            return l._compilerInfo.idx;
        }

        procIndex(a:Action):Procedure
        {
            return this.binary.procs.filter(n => n.action == a)[0]
        }

        localIndex(l:LocalDef, noargs = false):Location
        {
            return this.proc.locals.filter(n => n.def == l)[0] ||
                   (noargs ? null : this.proc.args.filter(n => n.def == l)[0])
        }

        visitFor(f:For)
        {
            var upper = this.proc.mkLocal()
            this.dispatch(f.upperBound);
            upper.emitStore(this.proc);

            var idx = this.localIndex(f.boundLocal);
            this.proc.emitInt(0);
            idx.emitStore(this.proc);

            var top = this.proc.emit("LABEL");
            var brk = this.proc.mkLabel();
            idx.emitLoad(this.proc);
            upper.emitLoad(this.proc);
            this.proc.emitCall("number::lt", 0);
            this.proc.emitJmp(brk, "JMPZ");

            var cont = this.proc.mkLabel();
            f._compilerBreakLabel = brk;
            f._compilerContinueLabel = cont;
            this.dispatch(f.body)

            this.proc.emitLbl(cont);
            idx.emitLoad(this.proc);
            this.emitInt(1);
            this.proc.emitCall("number::plus", 0);
            idx.emitStore(this.proc);
            Util.assert(this.proc.currStack == 0);
            this.proc.emitJmp(top);
            this.proc.emitLbl(brk);
        }

        visitForeach(f:Foreach)
        {
            //TODO
            Util.oops("foreach emit")
        }

        visitWhile(n:While)
        {
            var top = this.proc.emit("LABEL");
            var brk = this.proc.mkLabel()
            this.dispatch(n.condition)
            this.proc.emitJmp(brk, "JMPZ");

            n._compilerBreakLabel = brk;
            n._compilerContinueLabel = top;
            this.dispatch(n.body)

            this.proc.emitJmp(top);
            this.proc.emitLbl(brk);
        }

        visitInlineActions(i:InlineActions)
        {
            i.normalActions().forEach(a => a.name._lastWriteLocation = a)
            this.visitExprStmt(i)
        }

        visitExprStmt(es:ExprStmt)
        {
            if (es.isPlaceholder()) return

            this.dispatch(es.expr);
            var k = es.expr.parsed.getKind()
            if (k == api.core.Nothing)
                Util.assert(this.proc.currStack == 0)
            else {
                Util.assert(this.proc.currStack == 1)
                if (isRefKind(k))
                    // will pop
                    this.proc.emitCall("bitvm::decr", 0);
                else
                    this.proc.emit("pop {r0}", 0xbc01);
            }
        }

        visitCodeBlock(b:CodeBlock)
        {
            b.stmts.forEach(s => {
                this.dispatch(s);
                Util.assert(this.proc.currStack == 0);
            })
        }

        visitAction(a:Action)
        {
            this.proc = this.procIndex(a);

            var ret = this.proc.mkLabel()
            a._compilerBreakLabel = ret;
            this.dispatch(a.body)
            this.proc.emitLbl(ret)

            Util.assert(this.proc.currStack == 0)

            /*
            // clear all globals for memory debugging
            if (this.proc.index == 0) {
                this.binary.globals.forEach(g => {
                    if (g.isRef()) {
                        this.emitInt(0);
                        g.emitStore(this.proc);
                    }
                })
            }
            */

            var retl = a.getOutParameters()[0]

            this.proc.emitClrs(retl ? refl.local : null);

            if (retl) {
                this.localIndex(retl.local).emitLoad(this.proc)
                this.proc.emit("pop {r0}", 0xbc01);
            }

            Util.assert(this.proc.currStack == 0)

            this.proc.emit("POPLOCALS", 0); // sp -= sizeof(locals) + numargs
            this.proc.emit("pop {pc}", 0xbd00);
        }

        visitGlobalDef(g:GlobalDef)
        {
            var x = new Location(this.binary.globals.length, g)
            this.binary.globals.push(x)
        }

        visitLibraryRef(l:LibraryRef)
        {
            // skip
        }

        visitRecordDef(r:RecordDef)
        {
            Util.assert(r.recordType == RecordType.Object);

            var refs = r.getFields().filter(f => isRefKind(f.dataKind))
            var flats = r.getFields().filter(f => !isRefKind(f.dataKind))

            r._compilerInfo = { size: refs.length + flats.length, refsize: refs.length }

            refs.concat(flats).forEach((f, i) => {
                f._compilerInfo = { idx: i }
            })
        }

        prepAction(a:Action)
        {
            var p = new Procedure()
            this.proc = p;
            p.action = a;
            this.binary.procs.push(p)

            var inparms = a.getInParameters().map(p => p.local)
            this.proc.args = inparms.map((p, i) => {
                var l = new Location(i, p);
                l.isarg = true
                return l
            })

            if (inparms.length == 0)
                this.proc.emit("push {lr}", 0xb500);
            else if (inparms.length == 1)
                this.proc.emit("push {r0,lr}", 0xb501);
            else if (inparms.length == 2)
                this.proc.emit("push {r0,r1,lr}", 0xb503);
            else if (inparms.length == 3)
                this.proc.emit("push {r0,r1,r2,lr}", 0xb507);
            else if (inparms.length == 4)
                this.proc.emit("push {r0,r1,r2,r3,lr}", 0xb50f);
            else Util.oops("only up to 4 args supported at the moment " + a.getName())

            this.proc.emit("LOCALS", 0); // this is only resolved later when we know how many locals there are

            visitStmts(a.body, s => {
                if (s instanceof ExprStmt) {
                    var ai = (<ExprStmt>s).expr.assignmentInfo()
                    if (ai) {
                        ai.targets.forEach(t => {
                            var loc = t.referencedLocal()
                            var idx = inparms.indexOf(loc)
                            if (loc && idx >= 0) {
                                var curr = this.localIndex(loc, true)
                                if (!curr) {
                                    var l = this.proc.mkLocal(loc)
                                    this.proc.args[idx].emitLoad(this.proc)
                                    l.emitStore(this.proc)
                                }
                            }
                        })
                    }
                }
            })


            // this includes in and out parameters; we filter out the ins
            a.allLocals.forEach(l => {
                l._lastWriteLocation = null;
                if (inparms.indexOf(l) == -1)
                    this.proc.mkLocal(l)
            })
        }

        dump(lst:Decl[])
        {
            lst.forEach(t => {
                if (this.shouldCompile(t))
                    this.dispatch(t)
            })
        }

        prepApp(a:App)
        {
            a.allActions().forEach(a => {
                if (!this.shouldCompile(a)) return
                this.prepAction(a)
            })

            this.dump(a.libraries())
            this.dump(a.variables())
            this.dump(a.resources())
            this.dump(a.records())
        }

        compileApp(a:App)
        {
            this.dump(a.allActions().filter(a => !a.isActionTypeDef()))
        }

        visitApp(a:App)
        {
            Util.oops("")
        }

        visitComment(c:Comment)
        {
            // do nothing
        }

        visitStmt(s:Stmt)
        {
            Util.oops("unhandled stmt: " + s.nodeType())
        }
    }
}
