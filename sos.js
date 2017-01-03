'use strict';

const _ = require('lodash');

/// Common OS errors
class OSError extends Error {}

/// Critical errors, throwing will cause Kernel reboot
OSError.OSCriticalError = class extends OSError {};

/// Base class for OS processes, must be inherited from.
class Process {
    /// Predefined status enumeration
    static get STATUS() { return { DEAD: 0, ALIVE: 1, ASLEEP: 2 }; }

    /// Constructor called every tick by OS
    constructor(oscfg) {
        oscfg = oscfg || {};
        this.chs_ = (oscfg.children || []).slice(0);
        this.pid_ = oscfg.pid;
    }

    /// List of child processes' PIDs
    get children() { return this.chs_.slice(0); }

    /// Own PID
    get pid() { return this.pid_; }

    /// Default generator, example, detects missed (not registered) Process classes
    *run() {
        const str = `${this.constructor.name}`;
        throw new OSError.OSCriticalError('Abstract Process.*run() was called by '+str);
    }
}

const utils = {
    isGenerator: ((obj) => ('function' == typeof obj.next && 'function' == typeof obj.throw)),
    isGeneratorFunction: ((obj) => {
        const ctor = obj.constructor;
        return !ctor ? false :
            ('GeneratorFunction' === ctor.name || 'GeneratorFunction' === ctor.displayName) ? true :
            utils.isGenerator(ctor.prototype);
    }),
    isConvertibleToGF: ((obj) => (utils.isGeneratorFunction(obj) || (typeof obj == 'function'))),
    generify: ((g) => (utils.isGeneratorFunction(g) ? g : (function*(...args) { return g(...args) }))),
    unrollGenerator: ((f, ...args) => {
        const g = utils.isGenerator(f) ? f : utils.generify(f)(...args);
        for(let step of g) {}
    }),
    functionByName: ((name, context) => {
        const namespaces = name.split('.');
        const func = namespaces.pop();
        for(let i = 0; i < namespaces.length; ++i)
            context = context[namespaces[i]];
        return context[func];
    })
};

/**
 * Base class and namespace of OS's "interrupts".
 * Return or yield "new Interrupt.<INT>()" inside Process will cause special actions.
 */
class Interrupt {
    /// Predefined percent powers for some actions
    static get POWER() { return { LOW: 10, MEDIUM: 50, HIGH: 90 }; }

    /// Virtual fabric, allows "yield INT.XXX.create();" as "yield new INT.XXX();" TODO not works
    //static create(...args) { return new this.constructor(...args); }
}

/// Allows to interrupt process to be continued later this tick. Has no result.
Interrupt.Yield = class extends Interrupt {
    constructor(density) { super(); this.density = density || Interrupt.POWER.MEDIUM; }; };

/// Finishes execution at current tick and make it sleep for 'ticks'. Has no result.
Interrupt.Sleep = class extends Interrupt {
    constructor(ticks) { super(); this.ticks = ticks || 1; }; };

/// Creates new process (will start next tick). Result: child PID.
Interrupt.Fork = class extends Interrupt {
    constructor(priority, type, memory) { super(); this.args = [priority, type, memory]; }; };

/// Requests access to child process memory. Result: {status: s, memory: m}.
Interrupt.Inject = class extends Interrupt {
    constructor(pid) { super(); this.cpid = pid; }; };

/// Kills the current process. Has no result, 'yield' won't return.
Interrupt.Kill = class extends Interrupt {
    constructor() { super(); }; };

/// Reboots kernel. Has no result, 'yield' wont return.
Interrupt.Reboot = class extends Interrupt {
    constructor() { super(); }; };

/**
 * Kernel's entity.
 * Ordinary "class" (function), so several kernels can be constructed
 * and operated simultaneously.
 */
class Kernel {
    constructor(storage, time) {
        // Setting reference to storage object
        const memory_ = storage || (()=>{ throw new OSError.OSCriticalError('Undefined storage') })();

        /// Private ///

        memory_.executed = false;
        memory_.t        = time || 1 + (memory_.t || 0);
        memory_.table    = memory_.table || {};

        console.log('Kernel constructed (t = %d, st = %s)', memory_.t, JSON.stringify(memory_));

        const types   = {};
        const table   = memory_.table;
        const pidList = Object.keys(table).sort(k => +k);

        const executed = () => (memory_.executed);
        const complete = () => (memory_.executed = true);
        const reboot   = () => (complete());

        const acquireFreePID = () => {
            for(let i = 1;; ++i) {
                const idx = i-1;
                if(i != pidList[idx]) {
                    pidList.splice(idx, 0, i);
                    return i;
                }
            }
        };

        const createProcess = (pid, priority, type, memory) => {
            if(table[pid]) throw new OSError('PID already occupied');
            if(!(type.prototype instanceof Process)) throw new OSError('Invalid Process class');
            table[pid] = [pid, priority, type.name, (memory || {}), []];
            return true;
        };

        const handleTask = (task) => {
            const INT = Interrupt; // just an alias
            try {
                let interrupt = false;
                do {
                    const result = task.thread.next(task.yieldArg);
                    const ret = result.value;
                    delete task.yieldArg;
                    if(ret instanceof INT) {
                        switch(ret.constructor) {

                            case INT.Yield:
                                interrupt = (ret.density + task.priority/2) < _.random(0,100);
                                //console.log(`### YIELD(${task.entry[0]}) ###`);
                                break;

                            case INT.Sleep: // TODO: timing
                                result.done = true;
                                break;

                            case INT.Fork:
                                const newPID = acquireFreePID();
                                if(createProcess(newPID, ...ret.args)) {
                                    task.entry[4].push(newPID);
                                    task.yieldArg = newPID;
                                }
                                break;

                            case INT.Inject: // TODO: status
                                if(!task.process.children.includes(ret.cpid))
                                    task.thread.throw(new OSError('Access denied'));
                                const childEntry = table[ret.cpid];
                                task.yieldArg = {
                                    status: (childEntry ? Process.STATUS.ALIVE : Process.STATUS.DEAD),
                                    memory: (childEntry ? childEntry[3] : {}),
                                };
                                break;

                            case INT.Kill:
                                delete table[task.entry[0]];
                                result.done = true;
                                break;

                            case INT.Reboot:
                                reboot();
                                result.done = true;
                                break;
                        }
                    }
                    task.done = result.done;
                    interrupt = interrupt || result.done;
                } while(!interrupt);
            } catch(err) {
                task.done = true;
                if((err instanceof OSError.OSCriticalError) || !(err instanceof OSError))
                    throw err;
            }
        };

        /// Privileged ///

        this.register_ = (processType) => {
            const exists = types[processType.name];
            if(!exists) types[processType.name] = processType;
            else if(exists !== processType) throw new OSError.OSCriticalError('Processes types names collision');
        };


        this.exists_   = (pid) => (table[pid] !== undefined);
        this.runCore_  = (...args) => (createProcess(...args));
        this.execute_  = () => {
            if(executed()) return;

            const rp = 10; // shuffle power coefficient: priority ~ priority + [-rp,+rp]
            const adjPriority = (p) => (Math.round(_.random(-rp, +rp)*(50 - Math.abs(p - 50))/50.0) + p);

            // [pid, priority, type.name, memory, children];
            const schedule = _.chain(table)
                .map((entry) => {
                    const priority  = adjPriority(entry[1]);
                    const oscfg     = { children: entry[4].slice(0), pid: entry[0] };
                    const process   = new (types[entry[2]] || Process)(oscfg);
                    const generator = utils.generify(process.run.bind(process))(entry[3]);
                    return {
                        priority:   priority,   // randomized priority
                        process:    process,    // Process object
                        thread:     generator,  // "thread"-like generator
                        entry:      entry,      // back reference to table's entry
                        done:       false       // finish flag
                    };
                })
                .sortBy((obj) => (-obj.priority))
                .value();

            // Here schedule is sorted and prepared for execution

            try {
                while(!executed()) {
                    schedule.forEach(task => handleTask(task));
                    _.remove(schedule, task => task.done);
                    if(schedule.length === 0) complete();
                }
            } catch(err) {
                if(err instanceof OSError) {
                    complete();
                    console.log('Kernel panic: %s %s', err, err.stack);
                }
                else throw err;
            }
        };
    }

    /**
     * Registers given class to be used at current runtime:
     * @param processType - Process class
     */
    register(processType) { this.register_(processType) }

    /// Runs core (permanent) named process with given name if doesn't exists
    core(name, priority, type, memory) {
        if(name == 0) throw new OSError('Deprecated PID(0) for core processes');
        if(this.exists_(name)) return;
        this.runCore_(name, priority, type, memory);
    }

    execute() { this.execute_(); }
}

/**
 * Wraps OS calls by bulletproof shell.
 * @param f - function to be executed
 * @param args - ... and its arguments
 */
const sandbox = (f, ...args) => {
    try { f(...args); }
    catch(err) {
        console.log("### Kernel panic: current environment's OS terminated ###\n%s %s",
            JSON.stringify(err), err.stack);
    }
};

/// Main OS singleton, static class
const OS = (()=>{
    let kernel_;
    const processTypes = [];

    class OS {
        constructor() { throw new OSError.OSCriticalError("OS is static class, don't construct it"); }

        /// Direct access to OS'es kernel
        static get kernel() { return kernel_; }

        /// Allows Processes registering before Kernel initialization
        static register(type) {
            if(OS.kernel) OS.kernel.register(type);
            else processTypes.push(type);
        }

        /// Initializes OS'es kernel
        static init(memory, time) {
            if(kernel_) console.log('OS reinitialized, old kernel will be destroyed');
            kernel_ = new Kernel(memory, time);
            processTypes.forEach(t => kernel_.register(t));
        };

        /// Not necessary, see assignment below
        // static core(...args) { OS.kernel.core(...args); }
        // static execute(...args) { OS.kernel.execute(...args); }
    }

    const osProperties = Object.getOwnPropertyNames(OS);
    const kernelProperties = Object.getOwnPropertyNames(Kernel.prototype);

    /// OS <=> Kernel
    for(let propName of kernelProperties) {
        const ref = Kernel.prototype[propName];
        if(!osProperties.includes(propName) && (typeof ref === 'function') && ref !== Kernel)
            OS[propName] = ((...args)=>(OS.kernel[propName](...args)));
    }

    /// Full functional encapsulation
    OS.OSError   = OSError;
    OS.Process   = Process;
    OS.Interrupt = Interrupt;
    OS.INT       = Interrupt;

    return OS;
})();

module.exports = (()=>{
    return {
        Process:    Process,
        Interrupt:  Interrupt,
        Kernel:     Kernel,
        sandbox:    sandbox,
        OS:         OS
    };
})();