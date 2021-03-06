var pg;
try {
  pg = require('pg');
} catch (e) {
  try {
    pg = require('pg.js');
  } catch (e2) {
    console.log(e2);
    throw new Error("Could not access pg module. Please install either pg or pg.js.");
  }
}

var domain = require('domain');

var __logFn = null, makeDB;

module.exports = function PostgresGen(con, opts) { return makeDB.call(null, con, opts); };
module.exports.log = function log(fn) {
  if (!!fn && typeof fn === 'function') __logFn = fn;
};
module.exports.close = function() {
  return new Promise(function(ok) {
    pg.once('end', ok);
    pg.end();
  });
};
module.exports.pg = pg;

var nextId = (function() {
  var id = 0;
  return function() {
    if (id < Number.MAX_SAFE_INTEGER - 1) { id++; }
    else id = 0;
    return id;
  };
})();

function LiteralPart(p) { this.part = p; }
function literal(p) {
  return new LiteralPart(p);
}
module.exports.literal = module.exports.lit = literal;

var qRE = /\?/g, dnumRE = /\$([0-9]+)/g, dnameRE = /\$[-a-zA-Z0-9_]+/g;
var normalize = module.exports.normalizeQueryArguments = function(args) {
  if (args.length === 1 && args[0].hasOwnProperty('query') && args[0].hasOwnProperty('params')) return args[0];

  //watch out for arguments passed straight in
  if (args && !Array.isArray(args) && typeof args !== 'string' && typeof args.length === 'number') args = Array.prototype.slice.call(args, 0);

  var q, questions, params, options, i, count = 0, tmp;
  // tagged string template
  if (Array.isArray(args[0]) && Array.isArray(args[0].raw)) {
    q = Array.prototype.slice.call(args[0], 0);
    questions = true;
    params = Array.prototype.slice.call(args, 1);
    tmp = [];
    params.forEach(function(p, i) {
      // support literal interpolation too
      if (p instanceof LiteralPart) {
        if (Array.isArray(p.part)) {
          tmp.push(p.part);
          p.part.literalArray = true;
        } else {
          q[i - count] += p.part + q[(i - count) + 1];
          q.splice((i - count) + 1, 1);
          count++;
        }
      } else tmp.push(p);
    });
    params = tmp;
    q = q.join('?');
    args = '';
    i = 1;
    q = q.replace(qRE, function() { return '$' + i++; });
    options = {};
  } else {
    // check for apply-ish calls
    if (args.length === 1 && Array.isArray(args[0])) args = args[0];
    // allow for opt-arg only calls (useful for downstream libs)
    if (typeof args[0] !== 'string') args.unshift('');

    q = args[0];
    params = [];
    questions = q.indexOf('?') >= 0;
    options = {};
  }

  var dollarNums = !questions && dnumRE.test(q);
  var dollarNames = !questions && !dollarNums && dnameRE.test(q);
  var shifts = [], idx;

  if (args.length > 1) {
    if (questions || dollarNums) {
      // these require weird param arguments handling
      var paramCount = questions ? (q.match(qRE) || []).length : (q.match(dnumRE) || []).length;
      if (Array.isArray(args[1])) {
        params = args[1].slice(0, paramCount);
        if (args.length > 2) options = args[args.length - 1];
        else if (args[1].length > paramCount) options = args[1][args[1].length - 1];
      } else {
        for (i = 1; i <= paramCount; i++) params.push(args[i]);
        if (args.length > paramCount + 1) options = args[args.length - 1];
      }

      if (questions) {
        i = 1;
        q = q.replace(qRE, function() { return '$' + i++; });
      }
    } else if (dollarNames) {
      // dollarNames requires conversion to dollarNumbers
      var ps = args[1], arr = [];
      idx = 1;
      q = q.replace(dnameRE, function(m) {
        arr.push(ps[m.slice(1)]);
        return '$' + idx++;
      });
      params = arr;

      if (args.length > 2) options = args[args.length - 1];
    } else {
      options = args[args.length - 1];
    }
  }

  // TODO: option to handle array as literal in addition to looking for a property on the array

  // find any array parameters and replace them and their reference with their contents
  for (i = 0; i < params.length; i++) {
    var p = params[i];
    if (Array.isArray(p)) {
      var arargs = ['$' + (i + 1)];
      var qre = new RegExp('\\$' + (i + 1) + '(?![0-9])');
      for (var j = 1; j < p.length; j++) arargs.push('$' + (j + params.length));
      if (p.literalArray) {
        q = q.replace(qre, 'ARRAY[' + arargs.join(', ') + ']');
        if (p.length < 1) shifts.push(i + 1);
      } else {
        if (p.length < 1) {
          q = q.replace(qre, '(select 1 where false)');
          shifts.push(i + 1);
        } else {
          q = q.replace(qre, '(' + arargs.join(', ') + ')');
        }
      }
      params.splice(i, 1, p[0]);
      params = params.concat(p.slice(1));
    }
  }

  var fn = function(m, n) {
    if (+n === idx) return '';
    else if (+n > idx) return '$' + (+n - 1);
    else return m;
  };

  for (i = 0; i < shifts.length; i++) {
    idx = shifts[i];
    q = q.replace(dnumRE, fn);
  }
  for (i = shifts.length - 1; i >= 0; i--) {
    params.splice(shifts[i] - 1, 1);
  }

  var res = { query: q, params: params, options: options };
  return res;
};

var root;
root = {
  _connect: function() {
    var me = this;
    return new Promise(function(resolve, reject) {
      if (!me.pool) {
        var client = new pg.Client(me.conStr);
        client.connect(function(err) {
          if (err) reject(err);
          else resolve([client]);
        });
      } else {
        pg.connect(me.conStr, function(err, client, done) {
          if (err) reject(err);
          else resolve([client, done]);
        });
      }
    });
  },
  _query: function(connection, obj) {
    var me = this;
    var con, cleanup = false;
    if (!!connection) {
      con = Promise.resolve([connection]);
    } else if (!!me.connection) {
      con = Promise.resolve([me.connection]);
    } else if (!root._hasCurrent.call(me)) {
      con = root._connect.call(me);
      cleanup = true;
    } else {
      con = root._currentVal.call(me).begin();
    }

    return con.then(function(c) {
      var start = Date.now();

      return new Promise(function(resolve, reject) {
        c[0].query(obj.query, obj.params, function(err, res) {
          var time = Date.now() - start;

          try {
            var log = me.logFn || __logFn;
            if (log !== null) log({ name: me.name, query: obj.query, params: obj.params, string: me.conStr, time: time, error: err });
          } catch (e) { console.log(e); }

          if (err) { err.sql = obj.query; err.params = obj.params; reject(err); }
          else resolve(res);
          if (cleanup) {
            if (me.pool) c[1]();
            else c[0].end();
          }
        });
      });
    });
  },
  _nonQuery: function(connection, obj) {
    return root._query.call(this, connection, obj).then(function(res) {
      return res.rowCount;
    });
  },
  _queryOne: function(connection, obj) {
    return root._query.call(this, connection, obj).then(function(res) {
      if (res.rows.length > 0) {
        return res.rows[0];
      } else {
        return Promise.reject("No rows were returned where at least one was expected.");
      }
    });
  },
  _hasCurrent: function() {
    return !!root._currentVal.call(this);
  },
  _currentVal: function() {
    if (!this.domains) return;
    var res = domain.active;
    if (!!res) res = res.__pggenContext;
    if (!!res) res = res[this.connectionString()];
    if (!!res) res = res.trans;
    return res;
  },
  _killCurrent: function() {
    var res = domain.active;
    if (!!res) res = res.__pggenContext;
    if (!!res) delete res[this.connectionString()];
  },
  _current: function(fn) {
    var currentDomain = domain.active;
    if (!!!currentDomain) currentDomain = domain.create();
    var ctx = currentDomain.__pggenContext;
    if (!!!ctx) {
      ctx = currentDomain.__pggenContext = {};
    }
    var str = this.connectionString();
    if (!!!ctx[str]) ctx = ctx[str] = {};
    else ctx = ctx[str];

    var trans = ctx.trans || this.newTrans(),
        startTrans = ctx.trans;
    ctx.trans = trans;

    currentDomain.run(function() {
      fn({
        domain: currentDomain,
        trans: trans,
        init: !!!startTrans
      });
    });
  },
  _transact: function(gen) {
    var me = this;
    if (me.domains) {
    return new Promise(function(resolve, reject) {
      root._current.call(me, function(ctx) {
        root._transactMiddle.call(me, gen, { resolve: resolve, reject: reject }, ctx);
      });
    });
    } else {
      return new Promise(function(resolve, reject) {
        root._transactMiddle.call(me, gen, { resolve: resolve, reject: reject }, { init: true, trans: me.newTrans() });
      });
    }
  },
  _newTransact: function(gen) {
    var me = this;

    if (me.domains) {
      var currentDomain = domain.create();
      var ctx = currentDomain.__pggenContext = {};
      ctx = ctx[this.connectionString()] = {};
      ctx.trans = this.newTrans();

      return new Promise(function(resolve, reject) {
        currentDomain.run(function() {
          root._transactMiddle.call(me, gen, { resolve: resolve, reject: reject }, {
            domain: currentDomain,
            trans: ctx.trans,
            init: true
          });
        });
      });
    } else {
      return new Promise(function(resolve, reject) {
        root._transactMiddle.call(me, gen, { resolve: resolve, reject: reject }, { trans: me.newTrans(), init: true });
      });
    }
  },
  _transactMiddle: function(gen, deferred, ctx) { // TODO: fix me
    var trans = ctx.trans;
    var g = gen(trans);
    var next, abort;
    var me = this;
    abort = function(e) {
      // rollback if me is the top-level transaction
      if (ctx.init) {
        try {
          trans.rollback().then(function() {
            // closing the transaction, so drop the current trans context
            root._killCurrent.call(me);
            deferred.reject(e);
          }, function(e2) { deferred.reject([e, e2]); });
        } catch (e2) { deferred.reject([e, e2]); }
      } else { deferred.reject(e); }
    };
    next = function(res) {
      if (res.done) {
        if (ctx.init) {
          trans.commit().then(function() {
            // closing the transaction, so drop the current trans context
            root._killCurrent.call(me);
            deferred.resolve(res.value);
          }, abort);
        } else deferred.resolve(res.value);
      } else if (res.value && typeof res.value.then === 'function') {
        res.value.then(function(r) {
          try {
            next(g.next(r));
          } catch (e) {
            abort(e);
          }
        }, function(e) {
          abort(e);
        });
      } else {
        try {
          next(g.next(res.value));
        } catch (e) { abort(e); }
      }
    };
    next(g.next());
  }
};

makeDB = (function() {
  var proto = {};
  // transaction prototype
  var tproto = Object.create(proto);

  proto.name = '';
  proto.logFn = null;
  proto.pool = true;
  proto.pg = pg;

  proto.transaction = function(gen) { return root._transact.call(this, gen); };
  proto.newTransaction = function(gen) { return root._newTransact.call(this, gen); };
  proto.hasTransaction = function() { return root._hasTransaction.call(this); };
  proto.currentTransaction = function() {
    if (this.hasTransaction()) return domain.active.__pggenContext.trans;
    else return undefined;
  };
  proto.query = function() {
    return root._query.call(this, null, normalize(arguments));
  };
  proto.queryOne = function() {
    return root._queryOne.call(this, null, normalize(arguments));
  };
  proto.nonQuery = function() {
    return root._nonQuery.call(this, null, normalize(arguments));
  };
  proto.log = function(fn) {
    if (!!fn && typeof fn === 'function') this.logFn = fn;
  };
  proto.connectionString = function() { return this.conStr; };

  proto.close = function() {
    var pool = pg.pools.all[JSON.stringify(this.conStr)];
    if (!pool) return Promise.resolve(true);

    delete pg.pools.all[JSON.stringify(this.conStr)];

    return new Promise(function(ok) {
      pool.drain(function() {
        pool.destroyAllNow(ok);
      });
    });
  };

  tproto.close = function() {
    if (this.connection && this.closeOnDone) {
      if (this.pool) this.whenDone();
      else this.connection.end();

      this.connection = null;
      this.active = false;
      this.done = true;
    }
    return Promise.resolve(true);
  };

  tproto.begin = function() {
    var t = this;
    if (t.done) {
      return Promise.reject("Begin: This transaction is already complete.");
    } else if (!t.active) {
      return root._connect.call(t).then(function(c) {
        t.connection = c[0];
        t.active = true;
        if (t.pool) t.whenDone = c[1];
        return t.nonQuery('begin;').then(function() { return c; });
      });
    } else {
      return Promise.resolve([t.connection]);
    }
  };

  tproto.commit = function() {
    var t = this;
    if (t.done) {
      return Promise.reject("Commit: This transaction is already complete.");
    } else if (!t.active && !t.done) {
      t.done = true;
      return Promise.resolve(true);
    } else {
      return t.query('commit;').then(function() {
        t.successful = true;
        return t.close();
      }, function(err) {
        t.successful = false;
        return t.close().then(function() { throw err; });
      });
    }
  };

  tproto.rollback = function() {
    var t = this;
    if (!t.active || t.done) {
      return Promise.reject("Rollback: This transaction is already complete.");
    } else {
      return t.query('rollback;').then(function() {
        t.successful = false;
        return t.close();
      }, function(err) {
        t.successful = false;
        return t.close().then(function() { throw err; });
      });
    }
  };

  tproto.transaction = function(gen) {
    var me = this;
    return new Promise(function(resolve, reject) {
      root._transactMiddle.call(me, gen, { resolve: resolve, reject: reject }, { init: false, trans: me });
    });
  };

  tproto.query = function() {
    var t = this, args = normalize(arguments);
    if (!t.active) return t.begin().then(function() { return root._query.call(t, t.connection, args); });
    else return root._query.call(t, t.connection, args);
  };

  tproto.queryOne = function() {
    var t = this, args = normalize(arguments);
    if (!t.active) return t.begin().then(function() { return root._queryOne.call(t, t.connection, args); });
    else return root._queryOne.call(t, t.connection, args);
  };

  tproto.nonQuery = function() {
    var t = this, args = normalize(arguments);
    if (!t.active) return t.begin().then(function() { return root._nonQuery.call(t, t.connection, args); });
    else return root._nonQuery.call(t, t.connection, args);
  };

  tproto.active = false;
  tproto.done = false;
  tproto.closeOnDone = true;
  tproto.successful = false;
  tproto.whenDone = null;

  return function PostgresGen(arg, opts) {
    if (arg === undefined) throw new Error("You must supply a connection configuration.");
    opts = opts || {};
    var mid = Object.create(proto);
    var res = Object.create(mid);

    mid.newTrans = function newTrans() {
      var trans = Object.create(tproto);
      trans.conStr = mid.conStr;
      for (var k in res) if (res.hasOwnProperty(k)) trans[k] = res[k];
      trans.id = nextId();
      return trans;
    };

    if (typeof arg === "string") {
      mid.conStr = arg;
    } else if (typeof arg === "object") {
      if (!!arg.string) {
        mid.conStr = arg.string;
      } else {
        mid.conStr = 'postgresql://';
        if (arg.user) {
          mid.conStr += encodeURIComponent(arg.user);
          if (arg.password) mid.conStr += ':' + encodeURIComponent(arg.password);
          mid.conStr += '@';
        }
        if (!!arg.host) mid.conStr += encodeURIComponent(arg.host);
        else mid.conStr += 'localhost';
        if (!!arg.port) mid.conStr += ':' + arg.port;
        if (arg.db) mid.conStr += '/' + encodeURIComponent(arg.db);
        if (arg.hasOwnProperty('ssl')) mid.conStr += '?ssl=' + arg.ssl;
      }
      if (arg.hasOwnProperty('pool')) mid.pool = !!arg.pool;
      if (!!arg.log && typeof arg.log === 'function') res.logFn = arg.log;
      if (!!arg.name && typeof arg.name === 'string') res.name = arg.name;
    }

    res.literal = res.lit = literal;
    res.domains = false;

    return res;
  };
}());
