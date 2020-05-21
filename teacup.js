//////////////////////////////////////////
// CORE LANGUAGE-BUILDING FUNCTIONALITY //
//////////////////////////////////////////

// PIPELINE

function Pipeline(...steps) {
    this.steps = steps;
}

Pipeline.prototype.process = function (x) {
    for (var step of this.steps) {
        if (typeof(step) === "function")
            x = step(x);
        else
            x = step.process(x);
    }
    return x;
}

// LEXER

function Lexer(tokenDefinitions) {
    // Build a big ass regular expression
    var keys = Object.keys(tokenDefinitions);
    var regexps = keys.map(k => tokenDefinitions[k]);
    this.re = new RegExp("(" + regexps.join(")|(") + ")");
    // this.types associates each group in the regular expression
    // to a token type (group 0 => not matched => null)
    this.types = [null].concat(keys);
}

Lexer.prototype.process = function(text) {
    var pos = 0;
    // Splitting with a regular expression inserts the matching
    // groups between the splits.
    return text.split(this.re)
        .map((token, i) => ({
            type: this.types[i % this.types.length], // magic!
            text: token,
            start: pos,
            end: pos += (token || "").length
        }))
        .filter(t => t.type && t.type !== "comment" && t.text) // remove empty tokens
}


// PARSER

function Parser(priorities, finalize) {
    this.priorities = Object.assign(Object.create(null), priorities);
    this.finalize = finalize;
}

Parser.prototype.getPrio = function (t) {
    var x = this.priorities[t.type + ":" + t.text]
         || this.priorities[t.text]
         || this.priorities["type:" + t.type]
    if (x) return x;
    else throw SyntaxError("Unknown operator: " + t.text);
}

Parser.prototype.order = function (a, b) {
    if (!a && !b) return "done";
    if (!a) return 1;
    if (!b) return -1;
    var pa = this.getPrio(a).left;
    var pb = this.getPrio(b).right;
    return Math.sign(pb - pa);
}

Parser.prototype.process = function (tokens) {
    tokens = tokens.slice();
    var next = tokens.shift.bind(tokens);
    var stack = [];
    // middle points to the handle between the two
    // operators we are currently comparing
    // (null if the two tokens are consecutive)
    var middle = null;
    var left = undefined;
    var right = next();
    var current = [null, left];
    while (true) {
        switch (this.order(left, right)) {
        case "done":
            // Returned when left and right are both
            // undefined (out of bounds)
            return middle;
        case 1:
            // Open new handle; it's like inserting
            // "(" between left and middle
            stack.push(current);
            current = [middle, right];
            middle = null;
            left = right;
            right = next();
            break;
        case -1:
            // Close current handle; it's like inserting
            // ")" between middle and right and then
            // the newly closed block becomes the new middle
            current.push(middle);
            middle = this.finalize(current);
            current = stack.pop();
            left = current[current.length - 1];
            break;
        case 0:
            // Merge to current handle and keep going
            current.push(middle, right);
            middle = null;
            left = right;
            right = next();
            break;
        }
    }
}


// STANDARD FINALIZER

function finalize(node) {
    var l = node.length;
    if (l === 3 && !node[0] && !node[2])
        return node[1];
    return {type: node.map((x, i) => {
        if (i % 2 == 0)
            return x === null ? "_" : "E"
        else 
            return x.text
    }).join(" "),
            args: node.filter((x, i) => x && i % 2 == 0),
            ops: node.filter((x, i) => i % 2 == 1),
            start: node[0] ? node[0].start : node[1].start,
            end: node[l-1] ? node[l-1].end : node[l-2].end};
}



// ENVIRONMENT

function makeEnvironment(...bindingGroups) {
    var base = Object.create(null);
    for (var bindings of bindingGroups)
        Object.assign(base, bindings);
    return base;
}



// UTILITIES

function extractArgs(guard, node, strict) {
    // extractArgs("E = E", `a = b`)        ==> [a, b]
    // extractArgs("E = E", `a + b`)        ==> null
    // extractArgs("E = E", `a + b`, true)  ==> ERROR
    // extractArgs(/^E [/]+ E$/, `a /// b`) ==> [a, b]
    if (guard === node.type
        || guard instanceof RegExp && node.type.match(guard))
        return node.args || [];
    if (strict)
        throw Error("Expected '"+guard+"', got '"+node.type+"'");
    return null;
}

function unparenthesize(node) {
    var res = extractArgs("_ ( E ) _", node);
    return res ? res[0] : node;
}

function getList(node) {
    // getList(`a, b, c`) ==> [a, b, c]
    // getList(`a`)       ==> [a]
    return extractArgs(/^[E_]( [;,\n] [E_])+$/, node)
        || (node ? [node] : []);
}

function normalizeCall(node) {
    // normalizeCall(`a + b`)   ==> [+, [a, b]]
    // normalizeCall(`f(a, b)`) ==> [f, [a, b]]
    var args = extractArgs(/^[E_] [^ ]+ [E_]$/, node);
    if (args)
        return [node.ops[0], args];
    else if (args = extractArgs(/^E \( [E_] \) _$/, node))
        return [args[0], getList(args[1])];
    return null;
}

function normalizeAssignment(node) {
    // normalizeAssignment(`a = b`)    ==> [a, null, b]
    // normalizeAssignment(`f(a) = b`) ==> [f, [a], b]
    var lr = extractArgs("E = E", node, true);
    var fargs = normalizeCall(lr[0]);
    if (fargs)
        return [fargs[0], fargs[1], lr[1]];
    else
        return [lr[0], null, lr[1]];
}


// INTERPRETER

function Interpreter(handlers, env) {
    // We reverse the handlers so that the most recent
    // have precedence over the rest.
    this.handlers = handlers.slice().reverse();
    this.env = env;
}
Interpreter.prototype.eval = function (node, env) {
    for (var h of this.handlers) {
        var args = extractArgs(h.key, node, false);
        if (args)
            return h.func.apply(this, [node, env].concat(args));
    }
    throw SyntaxError("Unknown node type: " + node.type);
}
Interpreter.prototype.process = function (node) {
    return this.eval(node, this.env);
}


// PREFIX OPERATORS

function tagPrefixOperators(tokens) {
    var prevType = "start";
    for (var token of tokens) {
        if (prevType === "start" && token.type === "open") {
          prevType = token.type;
          continue;
        }
        if ((token.type === "infix" /*|| token.type === "open"*/) &&
            (prevType === "infix" || prevType === "open")) {
            prevType = token.type;
            token.type = "prefix";
        }
        else
            prevType = token.type;
    }
    console.log(tokens);
    return tokens;
}


////////////////////////////////
// TEACUP LANGUAGE DEFINITION //
////////////////////////////////

var Teacup = {};


// TOKEN TYPES

Teacup.tokenDefinitions = {
    number: "\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?",
    open: "[\\(\\[\\{]|\\b(?:let|for|if|begin)\\b",
    middle: "\\b(?:then|elif|else|in|do|when)\\b",
    close: "[\\)\\]\\}]|\\bend\\b",
    infix: "[,;\n]|[!@$%^&*|/?.:~+=<>-]+|\\b(?:and|or|not)\\b",
    word: "\\w+",
    string: "\"(?:[^\"]|\\\\.)*\"",
    comment: "#[^\n]*(?=\n|$)"
};


// PRIORITIES
function lassoc(n) { return {left: n, right: n - 1}; }
function rassoc(n) { return {left: n, right: n + 1}; }
function xassoc(n) { return {left: n, right: n}; }
function prefix(n) { return {left: n, right: 10004}; }
function suffix(n) { return {left: 10005, right: n}; }

Teacup.priorities = {

    // Brackets and control structures
    "type:open":     prefix(5),
    "type:middle":   xassoc(5),
    "type:close":    suffix(5),
    //"prefix:(":      {left: 5, right: 15006},

    // Lists
    "\n":            xassoc(15),
    ";":             xassoc(15),
    ",":             xassoc(25),

    // Assignment
    "=":             rassoc(35),

    // Lambda
    "->":            rassoc(35),

    // Comparison and logic
    "not":           prefix(105),
    "or":            lassoc(115),
    "and":           lassoc(125),
    ">":             xassoc(205),
    "<":             xassoc(205),
    ">=":            xassoc(205),
    "<=":            xassoc(205),
    "==":            xassoc(205),

    // Range
    "..":            xassoc(305),

    // Basic arithmetic
    "+":             lassoc(505),
    "-":             lassoc(505),
    "prefix:-":      prefix(605),
    "*":             lassoc(605),
    "/":             lassoc(605),
    "%":             lassoc(605),
    "^":             rassoc(705),

    // Other operators
    "type:infix":    xassoc(905),
    "type:prefix":   prefix(905),

    // Field access
    ".":             {left: 15005, right: 1004},

    // atoms
    "type:word":     xassoc(20005),
    "type:number":   xassoc(20005),
    "type:string":   xassoc(20005),
};
console.log(Teacup.priorities)


// ROOT ENVIRONMENT

function lazy(fn) { fn.lazy = true; return fn; }

Teacup.rootEnv = {
    true: true,
    false: false,
    null: null,
    "+": (a, b) => a + b,
    "-": (a, b) => a - b,
    "prefix:-": a => -a,
    "*": (a, b) => a * b,
    "/": (a, b) => a / b,
    "%": (a, b) => a % b,
    "^": Math.pow,
    "<": (a, b) => a < b,
    ">": (a, b) => a > b,
    "<=": (a, b) => a <= b,
    ">=": (a, b) => a >= b,
    "==": (a, b) => a == b,
    "..": (start, end) =>
        Array.apply(null, Array(end - start)).map((_, i) => i + start),
    "prefix:not": a => !a,
    "and": lazy((a, b) => a() && b()),
    "or": lazy((a, b) => a() || b()),
    Math: Math
}


// HANDLERS

Teacup.handlers = [];

// Helper functions (used by more than one handler)
function resolve(env, text) {
    if (text in env)
        return env[text];
    else
        throw ReferenceError("Undefined variable: '"+text+"'.");
}
function getField(obj, field) {
    var res = obj[field];
    if (typeof(res) === "function")
        // This is necessary for method calls to work.
        return res.bind(obj);
    return res;
}
function runCall(interpreter, node, env) {
    var res = normalizeCall(node);
    var fn = interpreter.eval(res[0], env);
    var args = res[1].map(x => () => interpreter.eval(x, env))
    if (fn.lazy)
        return fn.apply(interpreter, args);
    else
        return fn.apply(interpreter, args.map(t => t()));
}
function variableBinder(expr, env) {
    if (expr.type !== "word" && expr.type !== "infix" && expr.type !== "prefix")
        throw SyntaxError("Invalid variable declaration.");
    var pfx = expr.type === "prefix" ? "prefix:" : ""
    return function (value) {
        env[pfx + expr.text] = value;
    }
}
function buildFunction(self, decls, body, env) {
    return function () {
        var arguments = [].slice.call(arguments);
        var newEnv = Object.create(env);
        for (var decl of decls) {
            variableBinder(decl, newEnv)(arguments.shift());
        }
        return self.eval(body, newEnv);
    }
}

// Variables
Teacup.handlers.push({
    key: /^(word|infix)$/,
    func: (node, env) => resolve(env, node.text)
});

// Prefix operators
Teacup.handlers.push({
    key: "prefix",
    func: (node, env) => resolve(env, "prefix:" + node.text)
});

// Numbers
Teacup.handlers.push({
    key: "number",
    func: (node, env) => parseFloat(node.text)
});

// Strings
Teacup.handlers.push({
    key: "string",
    func: (node, env) => node.text.slice(1, -1)
});

// Simple operators
Teacup.handlers.push({
    key: /^[E_] ([!@#$%^&*+\/?<>=.-]+|and|or|not) E$/,
    func: function (node, env) {
        return runCall(this, node, env);
    }
});

// Parentheses evaluate what's between them
Teacup.handlers.push({
    key: "_ ( E ) _",
    func: function (node, env, x) {
        return this.eval(x, env);
    }
});

// Ditto for begin/end
Teacup.handlers.push({
    key: "_ begin E end _",
    func: function (node, env, x) {
        return this.eval(x, env);
    }
});

// Function calls
Teacup.handlers.push({
    key: "E ( E ) _",
    func: function (node, env) {
        return runCall(this, node, env);
    }
});

// Function call (no arguments)
Teacup.handlers.push({
    key: "E ( _ ) _",
    func: function (node, env, f) {
        return this.eval(f, env).call(this)
    }
});

// List notation [a, b, c, ...]
Teacup.handlers.push({
    key: "_ [ E ] _",
    func: function (node, env, x) {
        return getList(x).map(arg => this.eval(arg, env));
    }
});

// Empty list
Teacup.handlers.push({
    key: "_ [ _ ] _",
    func: (node, env) => []
});

// Indexing; we make it so that x[1, 2] <=> x[1][2]
Teacup.handlers.push({
    key: "E [ E ] _",
    func: function (node, env, obj, index) {
        return getList(index).reduce(
            (res, x) => getField(res, this.eval(x, env)),
            this.eval(obj));
    }
});

// Dot notation
Teacup.handlers.push({
    key: "E . E",
    func: function (node, env, obj, field) {
        var x = this.eval(obj, env);
        var f = field.type === "word" ?
            field.text :
            this.eval(field, env);
        return getField(x, f);
    }
});

// if x then y else z end
Teacup.handlers.push({
    key: /^_ if E then E( elif E then E)*( else E)? end _$/,
    func: function (node, env) {
        var exprs = [].slice.call(arguments, 2);
        while (exprs.length > 0) {
            if (exprs.length === 1)
                return this.eval(exprs[0], env);
            if (this.eval(exprs.shift(), env))
                return this.eval(exprs.shift(), env);
            else
                exprs.shift();
        }
    }
});

// sequences; of; statements
Teacup.handlers.push({
    key: /[,;\n]/,
    func: function (node, env) {
        var last = undefined;
        for (stmt of [].slice.call(arguments, 2)) {
            last = this.eval(stmt, env);
        }
        return last;
    }
});

// Anonymous functions: args -> body
Teacup.handlers.push({
    key: "E -> E",
    func: function (node, env, decl, body) {
        var args = getList(unparenthesize(decl));
        return buildFunction(this, args, body, env);
    }
});

// let x = y in z end
Teacup.handlers.push({
    key: "_ let E in E end _",
    func: function (node, env, rawDecls, body) {
        var decls = getList(rawDecls)
            .map(d => normalizeAssignment(d));
        var newEnv = Object.create(env);
        for (var decl of decls) {
            var value =
                decl[1]
                ? buildFunction(this, decl[1], decl[2], newEnv)
                : this.eval(decl[2], env);
            variableBinder(decl[0], newEnv)(value);
        }
        return this.eval(body, newEnv);
    }
});

function forHandler(v, list, cond, body, env) {
    var results = [];
    for (var x of this.eval(list, env)) {
        var newEnv = Object.create(env);
        variableBinder(v, newEnv)(x);
        if (!cond || this.eval(cond, newEnv)) {
            results.push(this.eval(body, newEnv));
        }
    }
    return results;
}

// for x in y do z end
Teacup.handlers.push({
    key: "_ for E in E do E end _",
    func: function (node, env, v, list, body) {
        return forHandler.call(this, v, list, null, body, env);
    }
});

// for x in y when c do z end
Teacup.handlers.push({
    key: "_ for E in E when E do E end _",
    func: function (node, env, v, list, cond, body) {
        return forHandler.call(this, v, list, cond, body, env);
    }
});


function teacup(source) {
    var lexer = new Lexer(Teacup.tokenDefinitions);
    var parser = new Parser(Teacup.priorities, finalize);
    var env = makeEnvironment(Teacup.rootEnv);
    var interpreter = new Interpreter(Teacup.handlers, env);
    var pipeline = new Pipeline(
        lexer,
        tagPrefixOperators,
        parser,
        interpreter
    )
    return pipeline.process(source);
}


///////////////////
// DISPLAY STUFF //
///////////////////

Teacup.rootEnv["log"] = function () {
    [].slice.call(arguments).forEach(function (arg) {
        var box = document.createElement("div");
        box.appendChild(document.createTextNode(arg));
        document.getElementById("result").appendChild(box);
    });
    return arguments[arguments.length - 1];
}

function makeNode(type, title, cls) {
    var box = document.createElement(type);
    box.className = cls;
    box.title = title;
    [].slice.call(arguments, 3).forEach(function (x) {
        box.appendChild(x);
    });
    return box;
}
function txt(t) {
    return document.createTextNode(t);
}

function simplify(node) {
    if (node[1].text.match(/[,;\n]/)) {
        var results = [];
        for (var i = 0; i < node.length; i++) {
            if (node[i] === null) {
                if (results.pop() === undefined) i++;
            }
            else results.push(node[i]);
        }
        return results;
    }
    return node;
}

function display(node) {
    if (!node) {
        return makeNode("span", "", "nil");
    }
    if (node.length === 3 && node[0] === null && node[2] === null) { // identifier
        return makeNode("span", node[1].text || "", node[1].type, txt(node[1].text));
    }
    let signature = node.map(function (x, i) {
                if (i % 2 == 0)
                    return x === null ? "_" : "E"
                else 
                    return x.text.replace("\n", "↵")
            }).join(" ");
    node = simplify(node);
    if (node.length === 1) { return node[0]; }
    var box = makeNode("span", signature, "inner");
    node.forEach(function (x, i) {
        if (i % 2 == 1) {
            var op = makeNode("span", signature, "op", txt(x.text.replace("\n", "↵")));
            box.appendChild(op);
        }
        else {
            if (x) x.title = signature;
            box.appendChild(x || txt(""));
        }
    });
    return box;

}

var displayPipeline = new Pipeline(
    new Lexer(Teacup.tokenDefinitions),
    tagPrefixOperators,
    new Parser(Teacup.priorities, display)
)

function processInput() {
    var s = document.getElementById("expr").value;
    var res = document.getElementById("ast");
    res.innerHTML = "";
    res.appendChild(displayPipeline.process(s));
    var res = document.getElementById("result");
    res.innerHTML = "";
    try {
        res.appendChild(txt(teacup(s)));
    }
    catch (e) {
        res.appendChild(txt("ERROR: " + e.message));
    }
}

function runDemo() {
    var inputbox = document.getElementById("expr");
    var examples = document.getElementById("examples");
    [].slice.call(examples.children).forEach(function (child, i) {
        var button = document.createElement("button");
        button.appendChild(txt(i || "Clear"));
        button.onclick = function (e) {
            inputbox.value = child.value;
        };
        examples.replaceChild(button, child);
        if (i === 1) { inputbox.value = child.value; }
    });

    document.getElementById("evaluate").onclick = processInput;
    document.getElementById("expr").onkeydown = function(e) {
      if (e.ctrlKey && e.keyCode == 13) {
        processInput();
      }
      if (e.keyCode == 9) {
        let { value, selectionStart, selectionEnd } = inputbox;
        e.preventDefault();
        inputbox.value = value.slice(0, selectionStart) + "  " + value.slice(selectionEnd);
        inputbox.setSelectionRange(selectionStart+2, selectionStart+2)
      }
    }
}

runDemo();
