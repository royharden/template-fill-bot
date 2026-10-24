// Deterministic ("canonical") JSON used for every hash in the app (lock, provenance, bundle).
// Rules: object keys sorted recursively (by UTF-16 code unit order, the default JS string sort), arrays kept in
// order, no whitespace, strings and numbers serialised as by JSON.stringify (so -0 becomes 0).
// Rejected (throws CanonicalJsonError): undefined anywhere (including object values and array holes),
// functions, symbols, bigint, non-finite numbers, non-plain objects (Date, Map, Set, class instances, typed
// arrays) and cycles. Rejecting instead of silently dropping keeps two different values from hashing alike.

export class CanonicalJsonError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError('non-finite number', path);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new CanonicalJsonError('undefined value', path);
    case 'function':
      throw new CanonicalJsonError('function value', path);
    case 'symbol':
      throw new CanonicalJsonError('symbol value', path);
    case 'bigint':
      throw new CanonicalJsonError('bigint value', path);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError('unsupported value', path);
  }

  const obj = value as object;
  if (stack.has(obj)) {
    throw new CanonicalJsonError('cycle', path);
  }
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) {
          throw new CanonicalJsonError('array hole', `${path}[${i}]`);
        }
        parts.push(encode(obj[i], `${path}[${i}]`, stack));
      }
      return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(obj)) {
      throw new CanonicalJsonError('non-plain object', path);
    }
    if (Object.getOwnPropertySymbols(obj).length > 0) {
      throw new CanonicalJsonError('symbol key', path);
    }
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`, stack)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(obj);
  }
}

/** Canonical JSON text of a JSON-compatible value. Throws CanonicalJsonError on anything else. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$', new Set<object>());
}
