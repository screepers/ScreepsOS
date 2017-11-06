'use strict';

const SOS_MODULE = (()=>{
    
    /// SOS global configuration
    const CFG = Object.freeze({
        DEBUG:              0,
        LOG_PREFIX:         '[os]: ',
        EXP_MA_WINDOW:      10,         // ~86% window, k = 2/(1 + W)
        EXP_MA_PRECISION:   3,          // number of decimal digits for MA
        SCHED_DURATION_K:   1,          // weight of process execution time while scheduling by priority
        TICK_TRIES_LIMIT:   10          // single thread tries-per-tick limit
    });

    
    const // #include
        os_utils        = require('./os_utils'),
        PriorityQueue   = os_utils.PriorityQueue;

    
    /// Debug actions
    const dbg_do = CFG.DEBUG ? ((f, ...args)=>(f(...args))) : (()=>{});
    
    /// Debug output
    const dbg_log = (...args) => dbg_do(console.log, ...args);


    /// Utility pack
    const utils = {
        isGenerator: ((obj) => (
            'function' === typeof obj.next && 'function' === typeof obj.throw)),

        isGeneratorFunction: ((obj) => {
            const ctor = obj.constructor;
            return !ctor ? false :
                ('GeneratorFunction' === ctor.name || 'GeneratorFunction' === ctor.displayName) ? true :
                    utils.isGenerator(ctor.prototype);
        }),

        isConvertibleToGF: ((obj) => (
            obj && (utils.isGeneratorFunction(obj) || ('function' === typeof obj)))),

        generify: ((g) => (
            utils.isGeneratorFunction(g) ? g : (function*(...args) { return g(...args) }))),

        unrollGenerator: ((f, ...args) => {
            const g = utils.isGenerator(f) ? f : utils.generify(f)(...args);
            for(let step of g) {}
        }),

        /// Monotonic mapping R => (0,100), sigmoid(50) == 50
        sigmoid: ((x)=>{
            const X = x - 50;
            return 50*(1 + X/(50 + Math.abs(X)));
        }),
        
        sigmoid_r: ((x)=>{
            return x >= 50 ? (-2500/(x - 100)) : (100*(x-25)/x);
        }),
        
        /// Exponential moving average, ma(new, old) 
        ema: ((()=>{
            const new_k = 2.0/(1.0 + CFG.EXP_MA_WINDOW);
            return (new_val, old_val) => +((new_k*(new_val - old_val) + old_val).toFixed(CFG.EXP_MA_PRECISION));
        })())
    };


    /// Workaround for "friend" access (symbol marker)
    const _friend = Symbol('_FRIEND_');
    const makeFriend = (x) => { x[_friend] = true; return x };
    const isFriend   = (x) => !!x[_friend];


    /// Uses for private fields encapsulating
    const _private = Symbol('_PRIVATE_');
    const defineProperty = Object.defineProperty;


    /// Common OS errors
    class OSError extends Error {
        constructor(msg) { super(CFG.LOG_PREFIX + "RUNTIME ERROR: " + msg); } }

    /// Critical errors, throwing will cause Kernel reboot
    const OSCriticalError = (OSError.OSCriticalError = class OSCriticalError extends OSError {
        constructor(msg) { super("KERNEL PANIC: " + msg); } });


    /**
     * Base class for storage types.
     * Allows to control serialization/deserialization and memory access.
     */
    class Storage {
        constructor(object) {
            // Default storage object
            this._dflt = object || {};
            
            if(!new.target || !new.target.prototype)
                throw new OSCriticalError('Storage{???}: class broken');
                
            const this_proto = new.target.prototype;
            const [get, set] = [this_proto.get, this_proto.set];
            if(!get || !set)
                throw new OSCriticalError(`Storage{${new.target.name}} has no get() & set() accessors`);

            const base_proto = Storage.prototype;
            const defaultUsed = (get === base_proto.get && set === base_proto.set);
            const overwritten = (get !== base_proto.get && set !== base_proto.set);
            if(defaultUsed) dbg_log(`WARNING: Storage{${new.target.name}} has default accessors`);
            else if(!overwritten)
                throw new OSCriticalError(`Storage{${new.target.name}} has incompatible accessors`);
        }
        
        get()       { return this._dflt;  }
        set(value)  { this._dflt = value; }
    }

    /**
     * ROM: being read at tick begin, being written at tick end. Example:
     *      get( ) { return JSON.parse(GLOBAL.MEMORY); }
     *      set(m) { GLOBAL.MEMORY = JSON.stringify(m) }
     * Typical usage: persistent storage (process table, states etc.).
     */
    Storage.ROM = class ROM extends Storage {};

    /**
     * RAM: used by Kernel as Heap memory, can be used within several ticks. Example:
     *      const [hdd, heap] = [rom.get(), ram.get()];
     *      if(!consistent(hdd, heap))
     *          <...reinitialize heap...>
     *      <...kernel execution...>
     *      rom.set(<...serialized heap...>);
     * Typical usage: schedule/runtime holder (constructed processes, caches).
     */ 
    Storage.RAM = class RAM extends Storage {};
    
    
    /// Resets process underlying states without reconstruction
    const initProcess = function(oscfg) {
        oscfg = oscfg || {};
        if(!isFriend(oscfg))
            throw new OSCriticalError('Process must not be constructed explicitly');

        const _this = this[_private];
        _this._parent   = oscfg.parent;
        _this._pid      = oscfg.pid;
        _this._children = (oscfg.children || []).map(pid => pid);
        _this._memory   = (oscfg.memory);

        // System clock sharing
        this.clock = oscfg.clock;
        this.quota = oscfg.quota;
        
        // Priority sharing
        this.priority = oscfg.priority;
    };
    
    
    /// Base class for OS processes
    class Process {
        
        constructor() {
            const _this = {}; // hidden data
            defineProperty(this, _private, { value: _this });
            _this._typeName = new.target.name;
        }
        
        get parent()    { return this[_private]._parent;    }
        get pid()       { return this[_private]._pid;       }
        get children()  { return this[_private]._children;  }
        get memory()    { return this[_private]._memory;    }
        
        get label()     { return this.memory._label;        }
        set label(str)  { this.memory._label = str + '';    }

        /// Default run(), prints process memory
        run() {
            const typeName = this[_private]._typeName;
            const jsonMem = JSON.stringify(this.memory);
            console.log(`${typeName}:${this.pid}, memory=${jsonMem}:`);
        }
    }


    /// Base class and namespace of OS'es "system calls".
    /// Returning or yielding "new SYSCALL.<TYPE>()" inside Process will cause special actions.
    class SYSCALL {}

    /// Interrupts process to be continued later this tick, same as "this_thread::yield()".
    /// Has no result.
    SYSCALL.Yield = class Yield extends SYSCALL {};

    /// Finishes execution at current tick and make it sleep for 'ticks' (default: 1).
    /// Has no result.
    SYSCALL.Sleep = class Sleep extends SYSCALL {
        constructor(ticks) { super(); this.ticks = +ticks || 1; }; };

    /// Creates new process (will be started next tick).
    /// Result: child PID.
    SYSCALL.Fork = class Fork extends SYSCALL {
        constructor(priority, Type, memory) { super(); this.args = [priority, Type, memory]; }; };

    /// Grants access to child process memory.
    /// Result: {status: s, memory: m}.
    SYSCALL.Inject = class Inject extends SYSCALL {
        constructor(pid) { super(); this.cpid = +pid; }; };

    /// Kills the current process.
    /// Has no result, 'yield' won't return.
    SYSCALL.Kill = class Kill extends SYSCALL {};

    /// Reboots kernel.
    /// Has no result, 'yield' wont return.
    SYSCALL.Reboot = class Reboot extends SYSCALL {};

    /// Requests for priority changing. 
    /// Result: newly set priority value.
    SYSCALL.Priority = class Priority extends SYSCALL {
        constructor(value) { super(); this.new_priority = +value; }; };

    
    /// Kernel entity.
    /// Several kernels can be constructed and operated simultaneously.
    const Kernel = (()=>{
        
        const drawTree = (table, pid) => {
            let out = '';
            const drawSubtree = (prefix, pid, end) => {
                const row = table[pid];
                if(!row) return;
                
                const entry = entryUnpack(row);
                const _ps = entry.memory._label ? `"${entry.memory._label}"` : '';
                const header = (end ? '`-- ' : '|-- ') +
                    `${entry.typeName}:${pid} ${_ps}\n`;
                out += prefix;
                out += header;

                const newPrefix = prefix + (end ? '    ' : '|    ');
                const children = entry.children.slice(0);
                children.sort((a,b)=>(entryUnpack(table[b]).priority - entryUnpack(table[a]).priority));
                for(let i = 0; i < children.length; ++i) {
                    const [childPID, newEnd] = [children[i], i === (children.length - 1)];
                    drawSubtree(newPrefix, childPID, newEnd);
                }
            };
            drawSubtree('', (pid || 0), true);
            return out;
        };
        
        /// All processes parent 
        class Tron extends Process {
            run() { dbg_do(()=>{
                console.log('/============== TRON ==============\\');
                console.log(drawTree(this[_private]._table));
                console.log('\\============== ^^^^ ==============/');
            });}
        }

        /// Constructs timer (clock) function for performance measurements
        const makeClock = (timeCounter) => (
            (typeof timeCounter === 'function' && !isNaN(timeCounter())) ?
                timeCounter : (() => (new Date()).getTime()));

        /// Constructs computational quota function
        const makeQuota = (timeCounter) => (
            (typeof timeCounter === 'function' && !isNaN(timeCounter())) ?
                timeCounter : (() => (+Infinity)));

        /// @returns non-existent PID by process table
        const acquireFreePID = (table) => {
            for(let pid = 1;; ++pid)
                if(!table[pid]) return pid;
        };

        const entryUnpack = (array) => ({
            pid:        array[0],
            priority:   array[1],
            typeName:   array[2],
            memory:     array[3],
            children:   array[4],   // children PID list
            parent:     array[5],   // parent PID
            _internal:  array[6]    // statistics, sleep counter etc.
        });

        const entryPack = (obj) => ([
            obj.pid,
            obj.priority,
            obj.typeName,
            obj.memory,
            obj.children,
            obj.parent,
            obj._internal
        ]);

        /// Initializes table + creates Tron if doesn't exists, @returns prepared memory object 
        const validateROM = function(rom) {
            rom.fs || (rom.fs = {}); // TODO: file system
            const table = rom.table || (rom.table = {});
            if(!table[0]) // Initializing Tron (PID:0)
                createProcess.call(this, table, 0, 0, Tron, {}, 0);
            else if(entryUnpack(table[0]).typeName !== Tron.name)
                throw new OSCriticalError('validateROM: invalid process table');
            return rom;
        };

        /// Adds new entry to table, makes all necessary checks
        const createProcess = function(table, pid, priority, Type, memory, parentPID) {
            (()=>{
                this.registerProcess(Type);
                if(table[pid])
                    throw new OSError(`createProcess: PID already occupied: ${pid}`);
                if(isNaN(priority))
                    throw new OSError(`createProcess: invalid priority: ${priority}`);
            })();

            priority = +priority;
            priority =  priority > 100  ? 100   :
                        priority <   0  ?   0   : Math.floor(priority);

            table[pid] = entryPack({
                pid:        pid,
                priority:   priority,
                typeName:   Type.name,
                memory:     (memory || {}),
                children:   [],
                parent:     parentPID,
                _internal:  {}
            });

            // Tron is a parent for itself (Dzhigurda!)
            const parentEntry = table[parentPID];
            if(!!pid && parentEntry)
                entryUnpack(parentEntry).children.push(pid);

            return true;
        };

        const killProcess = function(table, pid) {
            const row = table[pid];
            if(!pid || !row)
                throw new OSError(`Process not found to be killed: ${pid}`);
            
            const entry     = entryUnpack(row);
            const parentPID = +entry.parent;
            const parent    = entryUnpack(table[parentPID]);

            if(parent) {
                const remIndex = parent.children.indexOf(pid);
                if(remIndex === -1)
                    throw new OSCriticalError(`Tree error: ${parentPID} <-X ${pid} <-> [...]`);
                
                // Removing from parent child list
                parent.children.splice(remIndex, 1);
                
                // Tron reparenting
                entryUnpack(table[0]).children.push(...entry.children);
            }

            // Tron reparenting TODO: ok?
            // NOTE: numeric value overriding <row>[5]=<new>
            entry.children.forEach((childPID)=>(table[childPID] && (table[childPID][5] = 0)));

            delete table[pid];
        };

        const handleTask = function(table, task) {
            const clock = this[_private]._clock;
            const entry = task.entry;
            const sleep = new SYSCALL.Sleep();

            try {
                let interrupt = false;

                do { // Cycle over "yields" (generator unwinding)

                    const t = clock();
                    const result = !(task.yieldArg instanceof Error) ?
                        task.thread.next (task.yieldArg):
                        task.thread.throw(task.yieldArg);
                    task.duration = (task.duration || 0) + (clock() - t);

                    const ret = result.value || sleep;
                    delete task.yieldArg;

                    // SYSCALL processing
                    if(ret instanceof SYSCALL) {
                        switch(ret.constructor) {

                            case SYSCALL.Yield: { // TODO: density?
                                interrupt = true;
                            } break;

                            case SYSCALL.Sleep: {
                                const sleepDuration = ret.ticks;
                                if(!isNaN(sleepDuration)) {
                                    if(sleepDuration > 1)
                                        task.wakeUpIn = sleepDuration;
                                    result.done = true;
                                } else if(!result.done) {
                                    task.yieldArg = new OSError('Sleep: invalid duration');
                                }

                            } break;

                            case SYSCALL.Fork: {
                                const newPID = acquireFreePID(table);
                                try {
                                    const ok = createProcess.call(
                                        this, table, newPID, ...ret.args, entry.pid);
                                    task.yieldArg = ok ? newPID :
                                        (new OSError(`Fork: cannot create (PID:${newPID})`));
                                } catch(err) {
                                    if(!result.done)
                                        task.yieldArg = err;
                                }
                            } break;

                            case SYSCALL.Inject: {
                                if(!result.done) {
                                    const childPID = +ret.cpid;
                                    if(entry.children.includes(childPID)) {
                                        const childEntry = table[childPID];
                                        task.yieldArg = {
                                            status: (childEntry ? 1 : 0),
                                            memory: (childEntry ? entryUnpack(childEntry).memory : null) };
                                    } else {
                                        task.yieldArg = new OSError('Inject: access denied');
                                    }
                                }
                            } break;

                            case SYSCALL.Kill: {
                                killProcess.call(this, table, entry.pid);
                                result.done = true;
                            } break;

                            case SYSCALL.Reboot: {
                                task.reboot = true;
                                result.done = true;
                            } break;
                            
                            case SYSCALL.Priority: {
                                const desired = ret.new_priority;
                                if(!isNaN(desired)) {
                                    let priority = +desired;
                                    priority =  priority > 100  ? 100   :
                                                priority <   0  ?   0   : Math.floor(priority);

                                    // NOTE: numeric value overriding <row>[1]=<new>
                                    table[entry.pid][1] = priority;
                                    task. yieldArg = priority;
                                } else {
                                    if(!result.done)
                                        task.yieldArg = new OSError('Priority: invalid value');
                                }
                            } break;
                            
                            default: {
                                const msg = `Unexpected SYSCALL: ${ret.constructor}`;
                                task.yieldArg = new OSError(msg);
                                console.log(msg);
                            } break;
                        }
                    }

                    task.done = result.done;
                    interrupt = interrupt || result.done;

                } while(!interrupt);

            } catch(err) {
                task.done = true;
                try { // Bulletproof shell
                    console.log(`Thread ${entry.typeName}:${entry.pid} runtime error: `,
                        err, err.name, err.message);
                    task.error = err.message + '';
                } finally {
                    task.error = task.error || 'UNKNOWN ERROR';
                }
            }
        };
        
        // => _this._heap
        function bootloader() {
            const _this = this[_private];
            let [hdd, heap] = [_this._ROM.get(), _this._RAM.get()];
            if(!hdd || !heap)
                throw new OSCriticalError('bootloader: cannot load ROM and/or RAM');

            // Current tick == prev + 1
            const tick = 1 + (hdd.t || 0);

            // Heap updating
            heap = (()=>{
                // Reset needed
                if(isNaN(heap.t) || (tick !== 1 + heap.t) || !heap.ok || !heap.hdd_image) {
                    dbg_do(console.log, 'heap reset, old=', heap);
                    _this._RAM.set({});
                    heap = _this._RAM.get();
                    if(!heap)
                        throw new OSCriticalError('bootloader: cannot load RAM');
                    heap.hdd_image = hdd;
                }

                // Begin tick
                heap.t  = +tick;
                heap.ok = false;
                return heap;
            })();

            // Creating process table, FS etc.
            heap.hdd_image = validateROM.call(this, heap.hdd_image);
            
            _this._heap = heap;
            return _this._heap;
        }

        // => _this._queue, _this._heap.processes
        function makeSchedule() {
            const _this = this[_private];

            const types = _this._types;
            const heap  = _this._heap;
            const table = heap.hdd_image.table;
            
            (()=>{ // New processes creating
                const toBorn = _this._toBorn || [];
                while(toBorn.length > 0) {
                    const cfg = toBorn.shift();
                    if(!cfg) break;
                    const newPID = acquireFreePID(table);
                    createProcess.call(this, table, newPID, cfg.priority, cfg.type, cfg.memory, 0);
                    if(cfg.callback) cfg.callback(newPID);
                }
            })();

            (()=>{ // Processes killing
                const toKill = _this._toKill || [];
                while(toKill.length > 0) {
                    const pid = toKill.shift();
                    if(!pid) continue;
                    killProcess.call(this, table, pid);
                }
            })();
            
            const comp = PriorityQueue.keyComp('priority');
            const queue = new PriorityQueue(comp);
            
            _this._queue = queue;
            const processes = heap.processes || (heap.processes = {});

            // All existing PIDs
            const pids_list = Object.keys(table);

            const effective_priority = (()=>{
                const user_avg = (heap.hdd_image.user_dt || 0.001)/pids_list.length;
                return (entry) => {
                    const _internal = entry._internal;
                    const [raw, dur, skip] = [entry.priority, (_internal.dt || 0), (_internal.skip || 0)];
                    return raw*skip + CFG.SCHED_DURATION_K*(user_avg - dur)/user_avg;
                }
            })();
            
            for(let i = 0; i < pids_list.length; ++i) {
                const pid = pids_list[i];
                const entry = entryUnpack(table[pid]);
                const _internal = entry._internal;

                // Process is sleeping, continue
                if(_internal.wakeAt < heap.t)
                    continue;
                else delete _internal.wakeAt;

                // Assuming bad case ("runtime will fail"), mark all tasks skipped
                _internal.skip = 1 + (_internal.skip || 0);
                
                // Getting existing cached process OR constructing new one
                const process = processes[pid] || (processes[pid] = new (types[entry.typeName] || Process)());

                // Updating process internal states
                initProcess.call(process, makeFriend({
                    children:   entry.children,
                    parent:     entry.parent,
                    pid:        entry.pid,
                    memory:     entry.memory,
                    clock:      _this._clock,
                    quota:      _this._quota,
                    priority:   entry.priority
                }));
                
                // priority = f(priority, duration, skipped)
                const priority = effective_priority(entry);
                
                // Creating "thread" coroutine (generator or wrapped ordinary function)
                const thread = utils.generify(process.run.bind(process))();
                
                const task = queue.push({
                    priority:  +priority,
                    process:    process,
                    thread:     thread,
                    entry:      entry,
                    done:       false
                }); dbg_log('TASK:\n', task);
            }

            // Share table to Tron
            processes[0][_private]._table = table;
        }
        
        function executeSchedule() {
            const _this = this[_private];
            const clock = _this._clock;
            const quota = _this._quota;
            const queue = _this._queue;
            const table = _this._heap.hdd_image.table;
            
            const handler = handleTask.bind(this);
            const result = {ok:true, err:{}};

            try { do { // Cycle over priority queue tasks
                
                const task = queue.pop();
                if(!task) break;
                dbg_log('TOP:\n', task);

                const now   = clock();
                const limit = quota();

                // There is no CPU left, terminating
                if(limit < now) {
                    console.log(`CPU quota reached (${limit} < ${now}), abort`);
                    break;
                }

                const _internal = task.entry._internal;
                if(_internal.skip) delete _internal.skip;

                // Run thread
                handler(table, task);

                // Kernel reboot request
                if(task.reboot) {
                    console.log(`Kernel reboot requested by ${task.entry.typeName}:${task.entry.pid}`);
                    break;
                }

                // Job isn't done yet
                if(!task.done) {
                    task.tries = 1 + (task.tries || 0);
                    
                    // Rescheduling
                    if(task.tries < CFG.TICK_TRIES_LIMIT) {
                        task.priority = Math.floor(task.priority/2);
                        queue.push(task);
                    } else {
                        const entry = task.entry;
                        console.log(`thread ${entry.typeName}:${entry.pid} calls limit exceeded`);
                    }

                // Thread finished
                } else {
                    // Sleep counter
                    if(task.wakeUpIn)
                        _internal.wakeAt = _this._heap.t + task.wakeUpIn;

                    // CPU usage statistics
                    const task_dur = task.duration || 0;
                    _this._user_dt += task_dur;
                    _internal.dt = utils.ema(task_dur, _internal.dt || 0);
                    
                    // TODO: task.error display
                }

            } while(true); } catch(err) {
                try { // Something really bad happens
                    result.ok = false;
                    result.err = err || new Error('UNKNOWN ERROR');
                    console.log(err, err.name, err.message);
                } finally {}
            }
            
            return result;
        }
        
        function hibernate() {
            const _this = this[_private];
            const heap = _this._heap;
            if(!heap)
                throw new OSCriticalError('hibernate: heap is broken');
            
            heap.hdd_image.t = heap.t;
            _this._ROM.set(heap.hdd_image);
            
            heap.ok = true;
            _this._RAM.set(heap);
            delete _this._heap;
        }
        
        
        class Kernel {
            
            constructor(cfg) {
                const _this = {}; // hidden data
                defineProperty(this, _private, { value: _this });

                cfg = cfg || {rom:null, ram:null};
                if(!(cfg.rom instanceof Storage.ROM && cfg.ram instanceof Storage.RAM))
                    throw new OSCriticalError('Kernel.constructor: invalid ROM and/or RAM');
                
                cfg.clock = makeClock(cfg.clock);
                cfg.quota = makeQuota(cfg.quota);

                // Setting up kernel memory devices
                _this._ROM = cfg.rom;
                _this._RAM = cfg.ram;
                
                // Setting up performance clock and CPU quota
                _this._clock = cfg.clock;
                _this._quota = cfg.quota;

                // Setting up processes constructors list
                _this._types = {};
                if(cfg.types && Array.isArray(cfg.types))
                    cfg.types.forEach((Type) => this.registerProcess(Type));
                else if(cfg.types) throw new OSError(`Kernel.constructor: invalid types list`);

                this.registerProcess(Tron);
                dbg_log("KERNEL CONSTRUCTOR:\n", _this);
            }

            /// Registers given class to be used at current runtime, checks type requirements.
            /// @param Type - Process class
            registerProcess(Type) {
                if(!Type || !(Type.prototype instanceof Process) || !Type.name)
                    throw new OSError(`registerProcess: invalid Process class: ${Type}`);

                const types     = this[_private]._types;
                const existing  = types[Type.name];

                if(!existing) types[Type.name] = Type;
                else if(existing !== Type)
                    throw new OSCriticalError(`registerProcess: types collision: has ${existing}, new ${Type}`);
            }
            
            execute() {
                const _this = this[_private];
                const clock = _this._clock;

                let real_dt = clock();
                _this._user_dt = 0;
                
                // Loading from ROM, preparing and validating RAM
                bootloader.call(this);
                
                // Processes constructing, preparing priority queue
                makeSchedule.call(this);
                
                // Cycle over process queue
                const result = executeSchedule.call(this);
                
                if(result.ok) {
                    
                    real_dt = clock() - real_dt;
                    const user_dt = _this._user_dt;
                    const sys_dt = real_dt - user_dt;
                    
                    const hdd = _this._heap.hdd_image;
                    hdd.user_dt = utils.ema(user_dt, hdd.user_dt || 0);
                    hdd. sys_dt = utils.ema( sys_dt, hdd. sys_dt || 0);
                    
                    // Saving RAM, writing ROM
                    hibernate.call(this);
                    
                } else { throw result.err; }
            }
            
            /// @returns minimal copy of processes table
            _ps(memory) {
                const table = memory.table;
                const result = {};
                for(const [pid, row] of Object.entries(table)) {
                    const entry = entryUnpack(row);
                    result[entry.pid] = {
                        pid:       +pid,
                        priority:  +entry.priority,
                        process:    entry.typeName + '',
                        parent:    +entry.parent,
                        children:   entry.children.map(pid => +pid)
                    };
                }
                return result;
            }

            createProcess(cfg) {
                cfg = cfg || {};
                cfg.priority = Object.hasOwnProperty('priority') ? cfg.priority : 50;
                
                const _this = this[_private];
                const toBorn = _this._toBorn || (_this._toBorn = []);
                toBorn.push(cfg);
            }
            
            kill(pid) {
                const _this = this[_private];
                const toKill = _this._toKill || (_this._toKill = []);
                toKill.push(pid);
            }
            
            
        }
        
        return Kernel;
    })();
    
    return {
        Storage:    Storage,
        Process:    Process,
        SYSCALL:    SYSCALL,
        Kernel:     Kernel
    };
    
})();

module.exports = SOS_MODULE;
