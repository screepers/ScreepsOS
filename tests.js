'use strict';

const _ = require('lodash');
const sos = require('./sos.js');

global.jcon = (...args) => (console.log(JSON.stringify(...args)));

function* printer() {
    jcon(1); yield;
    jcon(2); yield;
}

class Monitor extends sos.Process {
    *run(memory) {
        jcon(memory);
        //yield* super.run(); // causes error
        jcon('m1');
        yield new sos.INT.Yield(_.random(0,100));
        yield sos.INT.Yield.create(_.random(0,100));
        jcon('m2');
        yield* printer();
        memory.x = memory.x || 0;
        ++memory.x;
        jcon(this.children);
        if(memory.x % 3 === 0 && this.children.length < 1)
            yield new sos.INT.Fork(sos.INT.POWER.MEDIUM, Monitor);
    }//*/

    /*run(memory) {
        jcon(memory);
        jcon('m1');
        jcon(this.test);
        jcon(this.children);
    }//*/
}

(function main() {
    console.log("Hello!");
    console.log("os =", sos);

    sos.utils.unrollGenerator(sos.utils.generify(console.log), "!");
    sos.utils.functionByName('console.log', global)('ololo!');

    sos.sandbox(()=>{
        let Memory = {};
        const ticks = 5;
        for(let time = 0; time < ticks; ++time) {
            const K = new sos.Kernel(Memory, time);
            K.register(Monitor);
            K.core("M100", 100, Monitor);
            K.core("M50", 50, Monitor);
            K.execute();
            Memory = JSON.parse(JSON.stringify(Memory));
        }
        //console.log(sos.Kernel().dump());
    });
})();