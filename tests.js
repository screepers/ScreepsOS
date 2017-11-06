'use strict';

const _ = require('lodash');
const K = require('./Kernel.js');

global.jcon = (...args) => (console.log(JSON.stringify(...args)));


/// Persistent storage
class HDD extends K.Storage.ROM {
    constructor() { super(); this._hdd = '{}'; }
    get( ) { return JSON.parse(this._hdd); }
    set(m) { this._hdd = JSON.stringify(m); }
}

/// Unstable RAM
class BAD_RAM extends K.Storage.RAM {
    constructor() { super(); this._ram = {}; }
    get( ) { return this._ram; }
    set(m) { this._ram = (Math.random() < 0.25 ? m : {}); }
}


function pq_test() {
    const PriorityQueue = require('./os_utils').PriorityQueue;
    const N     = 1000;
    const size  = 1000;
    
    for(let i = 0; i < N; ++i) {
        const sz = _.random(0, 2*size);
        let sample = [];
        for(let j = 0; j < sz; ++j)
            sample.push(_.random(-size, size));
        
        const valComp = PriorityQueue.valueComp;
        const keyComp = PriorityQueue.keyComp('priority');
        
        const val_pq = new PriorityQueue(valComp);
        const obj_pq = new PriorityQueue(keyComp);
        
        for(let x of sample) {
            val_pq.push(x);
            obj_pq.push({priority: x, value: x});
        }

        sample.sort((a,b)=>(a-b));
        sample.reverse(); // desc order
        
        let fails = 0;
        const result = [];
        for(let x of sample) {
            const top_val = val_pq.top();
            const pop_val = val_pq.pop();
            
            fails += (x       !== pop_val);
            fails += (top_val !== pop_val);

            result.push(pop_val);
            
            const top_obj = obj_pq.top();
            const pop_obj = obj_pq.pop();
            
            fails += (x             !== pop_obj.value);
            fails += (top_obj.value !== pop_obj.value);
            fails += (x             !== pop_obj.priority);
            fails += (top_obj.value !== pop_obj.priority);
        }
        
        if(fails > 0) {
            const msg = `pq_test fails\nspl=${sample}\nres=${result}`;
            console.log(msg);
            throw new Error(msg);
        }
    }
}

function ackermann_test() {

    // Makes closure with Process type and utility stuff
    const makeAckermann = ((m, n, resultHolder)=>{
        let mainPID = undefined;

        // Job coroutine
        const processJob = function*(xm, xn) {
            const memory = this.memory;
            const workers = memory.workers || (memory.workers = []);
            for(let idx = 0; idx < workers.length; ++idx) {
                const job = workers[idx];
                const [childPID, cm, cn] = job;

                // There is such a job
                if(cm === xm && cn === xn) {
                    const hook = yield new K.SYSCALL.Inject(childPID);
                    const childMem = hook.memory;

                    // Just not ready yet
                    if(!childMem.result)
                        return;

                    // Result ready
                    workers.splice(idx, 1);
                    childMem.die = true;
                    return childMem.result;
                }
            }

            // Not found, create worker
            const childPID = yield new K.SYSCALL.Fork(
                (this.priority + 1), Ackermann, { m: xm, n: xn });

            // Save scheduled worker
            workers.push([childPID, xm, xn]);
        };

        class Ackermann extends K.Process {
            *run() {
                const memory = this.memory;

                if(!this.label)
                    this.label = `A(${memory.m},${memory.n})`;

                if(memory.main && memory.result) {
                    resultHolder.result = memory.result;
                    console.log(`FINISHED: A(${memory.m},${memory.n})=${memory.result}`);
                    return new K.SYSCALL.Kill();
                }

                if(memory.die) {
                    //console.log(`TEMPORARY: A(${memory.m},${memory.n})=${memory.result}`);
                    //return new K.SYSCALL.Sleep(999999);
                    return new K.SYSCALL.Kill();
                }

                // = n+1, end of recursion
                if(memory.m === 0) {
                    memory.result = memory.n + 1; return;
                }

                const checkJob = processJob.bind(this);

                // = A(m-1, 1)
                if(memory.n === 0) {
                    const res = yield* checkJob(memory.m - 1, 1);
                    if(res) memory.result = res; return;
                }

                // = A(m-1, A(m, n-1)) => nTmp = A(m, n-1)
                if(isNaN(memory.nTmp)) {
                    const res = yield* checkJob(memory.m, memory.n - 1);
                    if(res) memory.nTmp = res;

                // = A(m-1, nTmp)
                } else {
                    const res = yield* checkJob(memory.m - 1, memory.nTmp);
                    if(res) memory.result = res;
                }
            }
        }

        return {
            launched: (()=>(!!mainPID)),
            cfg: {
                type:       Ackermann,
                memory:     {m:m, n:n, main:1},
                priority:   0,
                callback:   ((pid)=>(mainPID = pid))
            }
        };
    });
    
    const singleTest = ((m,n)=>{
        const rom = new HDD();
        const ram = new BAD_RAM();

        const holder = {};
        const Algo = makeAckermann(m, n, holder);

        const kernel = new K.Kernel({rom:rom, ram:ram});
        kernel.createProcess(Algo.cfg);

        const ticksLimit = 10000;
        for(let t = 0; (t < ticksLimit) && !holder.result; ++t)
            kernel.execute();

        return holder.result;
    });
    
    const fun = ((m,n)=>(
        m === 0 ? (n + 1) :
        n === 0 ? fun(m - 1, 1) : fun(m - 1, fun(m, n - 1))
    ));
    
    const [M, N] = [4, 4];
    for(let m = 0; m < M; ++m) {
        for(let n = 0; n < N; ++n) {
            const r1 = fun(m, n);
            const r2 = singleTest(m, n);
            if(r1 !== r2) {
                const msg = `ackermann_test fails\nr1=${r1}\nr2=${r2}`;
                console.log(msg);
                throw new Error(msg);
            }
        }
    }
    
    singleTest(3,3);
}

(function main() {
    pq_test();
    ackermann_test();
})();


