'use strict';

const _ = require('lodash');

/// Common OS errors
class OSError extends Error {}

/// Critical errors, throwing will cause Kernel reboot
OSError.OSCriticalError = class extends OSError {};

/// Base class for OS processes, must be inherited from.
class Process {
    /// Constructor called every tick by OS
    constructor(oscfg) {
        oscfg = oscfg || {};
        this.chs_ = (oscfg.children || []).slice(0);
    }

    /// Returns list of child processes' PIDs
    get children() { return this.chs_.slice(0); }

    /// Default generator, example, detects missed (not registered) Process classes
    *run() {  throw new OSError.OSCriticalError('Abstract Process.*run() was called');  }
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
        const g = utils.isGenerator(f) ? f :
            utils.isGeneratorFunction(f) ? f(...args) :
            utils.generify(f)(...args);
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

    /// Virtual fabric, allows "yield INT.XXX.create();" as "yield new INT.XXX();"
    static create(... args) { return new this.constructor(...args); }
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

/// Requests access to child process memory. Result: reference to child memory.
Interrupt.Inject = class extends Interrupt {
    constructor(pid) { super(); this.cpid = pid; }; };

/// Kills the current process. Has no result, 'yield' won't return.
Interrupt.Kill = class extends Interrupt {
    constructor() { super(); }; };

/// Reboots kernel. Has no result, 'yield' wont return.
Interrupt.Reboot = class extends Interrupt {
    constructor() { super(); }; };

/**
 * Main Kernel's singleton. Explicitly extended below.
 * Can be accesses by "Kernel()" or constructed as "new Kernel".
 */
class Kernel {
    constructor(storage, time) {
        // Setting reference to storage object
        const memory_ = storage || (()=>{ throw new OSError.OSCriticalError('Undefined storage') })();

        /// Private ///

        memory_.executed    = false;
        memory_.t           = time || 1 + (memory_.t || 0);
        memory_.table       = memory_.table || {};

        console.log('Kernel constructed (t = %d, st = %s)', memory_.t, JSON.stringify(memory_));

        const types     = {};
        const table     = memory_.table;
        const pidList  = _.chain(table).keys().sortBy(k => +k).value();

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
                                console.log(`### YIELD(${task.entry[0]}) ###`);
                                break;
                            case INT.Sleep: // TODO: timing
                                interrupt = true;
                                break;
                            case INT.Fork:
                                const newPID = acquireFreePID();
                                if(createProcess(newPID, ...ret.args))
                                    task.entry[4].push(newPID);
                                task.yieldArg = newPID;
                                break;
                            case INT.Inject:
                                if(!_.includes(task.thread.children, ret.cpid))
                                    task.throw(new OSError('Access denied'));
                                task.yieldArg = table[ret.cpid][3];
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

        this.register_ = (processType) => (types[processType.name] = processType);
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
                    const oscfg     = { children: entry[4].slice(0) };
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
                    _.forEach(schedule, task => handleTask(task));
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
 * @param f - function to be executed.
 */
const sandbox = (f) => {
    try {
        f();
    } catch(err) {
        console.log('### Kernel panic: OS terminated for current tick ###');
        console.log('%s %s', JSON.stringify(err), err.stack);
    }
};

module.exports = (()=>{
    return {
        utils:      utils,
        Process:    Process,
        Interrupt:  Interrupt,
        INT:        Interrupt, // alias
        Kernel:     Kernel,
        sandbox:    sandbox
    };
})();