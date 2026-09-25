// 诊断预载：捕获谁给 globalThis.window 赋值 / 谁访问 window.addEventListener
let _win;
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  get() { return _win; },
  set(v) {
    console.error('\n[TRACE] window ASSIGNED, type=', typeof v,
      'hasAddEventListener=', v && typeof v.addEventListener);
    console.error(new Error('window-assign stack').stack);
    // 包一层：拦截 addEventListener 访问
    if (v && typeof v === 'object' && typeof v.addEventListener !== 'function') {
      const orig = v;
      _win = new Proxy(orig, {
        get(t, p, r) {
          if (p === 'addEventListener' || p === 'removeEventListener') {
            console.error('\n[TRACE] access window.' + String(p) + ' (NOT a function on target)');
            console.error(new Error('addEventListener-access stack').stack);
            return function () { /* noop */ };
          }
          return Reflect.get(t, p, r);
        }
      });
    } else {
      _win = v;
    }
  }
});
