/** JSON parser for authenticated records. Rejects ambiguous keys and excessive nesting. */
export function parseStrictJson(input, errorCode = 'INVALID_JSON', { maxDepth = 64 } = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  let i = 0;
  const fail = () => {
    throw new Error(errorCode);
  };
  const ws = () => {
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r') i += 1;
  };
  const string = () => {
    if (text[i] !== '"') fail();
    const start = i++;
    while (i < text.length) {
      if (text[i] === '"') {
        i += 1;
        try {
          return JSON.parse(text.slice(start, i));
        } catch {
          fail();
        }
      }
      if (text[i] === '\\') {
        i += 1;
        if (text[i] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail();
          i += 5;
        } else {
          if (!/["\\/bfnrt]/.test(text[i] || '')) fail();
          i += 1;
        }
      } else {
        if (text.charCodeAt(i) < 0x20) fail();
        i += 1;
      }
    }
    fail();
  };
  const value = (depth = 0) => {
    if (depth > maxDepth) fail();
    ws();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i += 1;
      const out = Object.create(null);
      const keys = new Set();
      ws();
      if (text[i] === '}') return ((i += 1), out);
      for (;;) {
        ws();
        const key = string();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail();
        if (keys.has(key)) fail();
        keys.add(key);
        ws();
        if (text[i++] !== ':') fail();
        Object.defineProperty(out, key, {
          value: value(depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        });
        ws();
        if (text[i] === '}') return ((i += 1), out);
        if (text[i++] !== ',') fail();
      }
    }
    if (text[i] === '[') {
      i += 1;
      const out = [];
      ws();
      if (text[i] === ']') return ((i += 1), out);
      for (;;) {
        out.push(value(depth + 1));
        ws();
        if (text[i] === ']') return ((i += 1), out);
        if (text[i++] !== ',') fail();
      }
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!match) fail();
    i += match[0].length;
    if (match[0] === 'true') return true;
    if (match[0] === 'false') return false;
    if (match[0] === 'null') return null;
    const number = Number(match[0]);
    if (
      !Number.isFinite(number) ||
      Object.is(number, -0) ||
      (Number.isInteger(number) && !Number.isSafeInteger(number))
    )
      fail();
    return number;
  };
  const result = value();
  ws();
  if (i !== text.length) fail();
  return result;
}
