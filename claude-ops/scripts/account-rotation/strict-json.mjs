/** JSON.parse-compatible parser which rejects duplicate decoded object keys. */
export function parseStrictJson(input, errorCode = 'INVALID_JSON') {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  let i = 0;
  const fail = () => {
    throw new Error(errorCode);
  };
  const ws = () => {
    while (/\s/.test(text[i] || '')) i += 1;
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
  const value = () => {
    ws();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i += 1;
      const out = {};
      const keys = new Set();
      ws();
      if (text[i] === '}') return ((i += 1), out);
      for (;;) {
        ws();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        ws();
        if (text[i++] !== ':') fail();
        out[key] = value();
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
        out.push(value());
        ws();
        if (text[i] === ']') return ((i += 1), out);
        if (text[i++] !== ',') fail();
      }
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!match) fail();
    i += match[0].length;
    return match[0] === 'true' ? true : match[0] === 'false' ? false : match[0] === 'null' ? null : Number(match[0]);
  };
  const result = value();
  ws();
  if (i !== text.length) fail();
  return result;
}
