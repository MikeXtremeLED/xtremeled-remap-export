'use strict';
// Minimale dependency-vrije XML parser — voldoende voor Resolume ScreenSetup files.
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SXML = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function decode(s) {
    return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
      if (e === 'amp') return '&';
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      if (e[0] === '#') {
        return String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        );
      }
      return m;
    });
  }

  function findTagEnd(xml, start) {
    let q = null;
    for (let i = start + 1; i < xml.length; i++) {
      const c = xml[i];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") {
        q = c;
      } else if (c === '>') {
        return i;
      }
    }
    return -1;
  }

  function parseTagBody(body) {
    const m = body.match(/^([\w:.\-]+)/);
    const el = { tag: m ? m[1] : '?', attrs: {}, children: [] };
    const rest = body.slice(m ? m[1].length : 0);
    const re = /([\w:.\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = re.exec(rest))) {
      el.attrs[a[1]] = decode(a[2] !== undefined ? a[2] : a[3]);
    }
    return el;
  }

  function parse(xml) {
    const root = { tag: '#document', attrs: {}, children: [] };
    const stack = [root];
    let i = 0;
    while (i < xml.length) {
      const lt = xml.indexOf('<', i);
      if (lt === -1) break;
      if (xml.startsWith('<!--', lt)) {
        const e = xml.indexOf('-->', lt);
        i = e === -1 ? xml.length : e + 3;
        continue;
      }
      if (xml[lt + 1] === '?') {
        const e = xml.indexOf('?>', lt);
        i = e === -1 ? xml.length : e + 2;
        continue;
      }
      if (xml[lt + 1] === '!') {
        const e = xml.indexOf('>', lt);
        i = e === -1 ? xml.length : e + 1;
        continue;
      }
      const gt = findTagEnd(xml, lt);
      if (gt === -1) break;
      const inner = xml.slice(lt + 1, gt).trim();
      if (inner[0] === '/') {
        if (stack.length > 1) stack.pop();
        i = gt + 1;
        continue;
      }
      const selfClose = inner.endsWith('/');
      const el = parseTagBody(selfClose ? inner.slice(0, -1) : inner);
      stack[stack.length - 1].children.push(el);
      if (!selfClose) stack.push(el);
      i = gt + 1;
    }
    return root.children[0] || null;
  }

  function childrenByTag(el, tag) {
    return el ? el.children.filter((c) => c.tag === tag) : [];
  }

  function firstChild(el, tag) {
    return el ? el.children.find((c) => c.tag === tag) || null : null;
  }

  function findAllDeep(el, pred, acc) {
    acc = acc || [];
    if (!el) return acc;
    if (pred(el)) acc.push(el);
    for (const c of el.children) findAllDeep(c, pred, acc);
    return acc;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return { parse, childrenByTag, firstChild, findAllDeep, esc };
});
