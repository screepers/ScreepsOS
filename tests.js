'use strict';

const _ = require('lodash');
const sos = require('./sos.js');

global.jcon = (...args) => (console.log(JSON.stringify(...args)));

function* printer() {
    jcon(1); yield;
    jcon(2); yield;
}

class Monitor extends sos.Process {
    constructor(...args) { super(...args); this.test = 'Amma Monitor!'; }

    *run(memory) {
        jcon(memory);
        //yield* super.run(); // causes error
        jcon('m1');
        yield new sos.INT.Yield(_.random(0,100));
        jcon('m2');
        yield* printer();
        memory.x = memory.x || 0;
        ++memory.x;
        if(memory.x % 3 === 0)
            yield new sos.INT.Fork(sos.INT.POWER.MEDIUM, Monitor);
    }
}

sos.Kernel().register(Monitor);

(function main() {
    console.log("Hello!");
    console.log("os =", sos);

    sos.utils.unrollGenerator(sos.utils.generify(console.log), "!");
    sos.utils.functionByName('console.log', global)('ololo!');

    sos.environment(()=>{
        let Memory = {};
        const ticks = 5;
        for(let time = 0; time < ticks; ++time) {
            sos.Kernel().init(Memory);
            sos.Kernel().core("M100", 100, Monitor);
            sos.Kernel().core("M50", 50, Monitor);
            sos.Kernel().execute();
            Memory = JSON.parse(JSON.stringify(Memory));
        }
        console.log(sos.Kernel().dump());
    });
})();