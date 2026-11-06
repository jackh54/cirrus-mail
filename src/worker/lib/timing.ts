// Per-request Server-Timing: total time, plus time spent waiting on D1 and R2.
// D1/R2 time is wall-clock time with at least one call in flight (parallel calls are not double-counted);
// `desc` is the number of network round trips (a db.batch is one).

interface Span { ms: number; n: number; open: number; since: number }

const span = (): Span => ({ ms: 0, n: 0, open: 0, since: 0 });

function track<T>(s: Span, p: Promise<T>): Promise<T> {
  if (s.open++ === 0) s.since = performance.now();
  s.n++;
  return p.finally(() => {
    if (--s.open === 0) s.ms += performance.now() - s.since;
  });
}

const D1_CALLS = new Set<PropertyKey>(['first', 'all', 'run', 'raw']);
const R2_CALLS = new Set<PropertyKey>(['get', 'put', 'head', 'delete', 'list']);

export class Meter {
  private start = performance.now();
  private d1 = span();
  private r2 = span();

  /** `env` with DB and BUCKET wrapped so their network calls are timed. */
  instrument(env: Env): Env {
    const db = this.wrapD1(env.DB);
    const bucket = this.wrapR2(env.BUCKET);
    return new Proxy(env, { get: (t, k) => (k === 'DB' ? db : k === 'BUCKET' ? bucket : Reflect.get(t, k)) });
  }

  header(): string {
    const f = (n: number) => n.toFixed(1);
    return `total;dur=${f(performance.now() - this.start)}, d1;dur=${f(this.d1.ms)};desc="${this.d1.n}", r2;dur=${f(this.r2.ms)};desc="${this.r2.n}"`;
  }

  private wrapD1(db: D1Database): D1Database {
    // db.batch() needs the real statements, so remember which wrapper belongs to which.
    const real = new WeakMap<object, D1PreparedStatement>();
    const d1 = this.d1;
    const wrapStmt = (s: D1PreparedStatement): D1PreparedStatement => {
      const w = new Proxy(s, {
        get(t, k) {
          if (k === 'bind') return (...a: unknown[]) => wrapStmt(t.bind(...a));
          const v = Reflect.get(t, k);
          if (typeof v !== 'function') return v;
          return D1_CALLS.has(k) ? (...a: unknown[]) => track(d1, v.apply(t, a)) : v.bind(t);
        },
      });
      real.set(w, s);
      return w;
    };
    return new Proxy(db, {
      get(t, k) {
        if (k === 'prepare') return (q: string) => wrapStmt(t.prepare(q));
        if (k === 'batch') return (stmts: D1PreparedStatement[]) => track(d1, t.batch(stmts.map((s) => real.get(s) ?? s)));
        if (k === 'exec') return (q: string) => track(d1, t.exec(q));
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  }

  private wrapR2(bucket: R2Bucket): R2Bucket {
    const r2 = this.r2;
    return new Proxy(bucket, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (typeof v !== 'function') return v;
        return R2_CALLS.has(k) ? (...a: unknown[]) => track(r2, v.apply(t, a)) : v.bind(t);
      },
    });
  }
}
