/**
 * D1 drops a query now and then with "Network connection lost" (or a reset).
 * It retries reads on its own but not writes, so a sign-up could fail or hang
 * halfway. This wraps the binding so every query is tried up to three times.
 * A write that did land the first time fails its retry on a unique key, which
 * reports the error as it was instead of hiding it.
 */
const TRANSIENT = /Network connection lost|storage caused object to be reset|reset because its code was updated|internal error/i;
const TRIES = 3;

async function retry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= TRIES || !TRANSIENT.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

const originals = new WeakMap<object, D1PreparedStatement>();

function statement(s: D1PreparedStatement): D1PreparedStatement {
  const proxy = new Proxy(s, {
    get(target, key) {
      if (key === "bind") return (...values: unknown[]) => statement(target.bind(...values));
      if (key === "all" || key === "run" || key === "first" || key === "raw") {
        return (...args: unknown[]) => retry(() => (target[key] as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  originals.set(proxy, s);
  return proxy;
}

export function retrying(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => statement(target.prepare(sql));
      if (key === "batch") {
        return (list: D1PreparedStatement[]) => retry(() => target.batch(list.map((s) => originals.get(s) ?? s)));
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
