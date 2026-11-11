const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('customer pop-ups use latest status on login and replace queued outdated statuses', async () => {
  const source = fs.readFileSync(require.resolve('../../public/js/kiosk.js'), 'utf8');
  const component = source.slice(source.indexOf('function OrderAlerts('), source.indexOf('function Notifications('));
  let rows = [{ id: 3, orderId: 'paid', status: 'Confirmed', readAt: null }, { id: 2, orderId: 'paid', status: 'Waiting for payment', readAt: null }, { id: 1, orderId: 'old', readAt: '2026-11-11T12:00:00Z' }], queue = [], poll, cleanup;
  const events = new Map();
  const context = vm.createContext({
    useState: () => [queue, (update) => { queue = update(queue); }],
    useRef: (current) => ({ current }), useEffect: (effect) => { cleanup = effect(); },
    api: async () => ({ alerts: rows }),
    setInterval: (fn) => { poll = fn; return 1; }, clearInterval: () => {},
    document: { addEventListener: (key, fn) => events.set(key, fn), removeEventListener: (key) => events.delete(key) },
    ALERT_STATUS: { Ready: 'Ready for pickup' }, html: () => null,
  });
  vm.runInContext(component + '\nOrderAlerts({ onOpen() {} });', context);
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(queue, (a) => a.id), [3]);
  rows = [{ id: 5, orderId: 'other', status: 'Preparing' }, { id: 4, orderId: 'paid', status: 'Ready' }, ...rows];
  await poll();
  assert.deepEqual(Array.from(queue, (a) => a.id), [4, 5]);
  await poll();
  assert.equal(queue.length, 2);
  cleanup();
  assert.equal(events.size, 0);
});

test('status card collapses after 5 seconds and can be expanded again', () => {
  const source = fs.readFileSync(require.resolve('../../public/js/kiosk.js'), 'utf8');
  const component = source.slice(source.indexOf('function OrderAlertCard('), source.indexOf('function Notifications('));
  let expanded = true, previousDeps, cleanup, nextTimer = 0;
  const timers = new Map();
  let opened = 0;
  const onOpen = () => { opened++; };
  const context = vm.createContext({
    useState: () => [expanded, (value) => { expanded = typeof value === "function" ? value(expanded) : value; }],
    useEffect: (effect, deps) => {
      if (!previousDeps || deps.some((value, i) => value !== previousDeps[i])) {
        cleanup?.(); previousDeps = deps; cleanup = effect();
      }
    },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    ALERT_STATUS: { CONFIRMED: 'Confirmed' }, NavIcon: () => {},
    html: (strings, ...values) => ({ strings, values }),
    props: { alert: { id: 1, orderId: 'order', orderNumber: 112, status: 'CONFIRMED' }, onOpen, onDismiss() {} },
  });
  vm.runInContext(component, context);
  const render = () => vm.runInContext('OrderAlertCard(props)', context);
  let card = render();
  assert.match(card.values[0], /expanded/);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 5000);
  render(); // Unchanged polling/renders must not restart the countdown.
  assert.equal(nextTimer, 1);
  [...timers.values()][0].callback();
  card = render();
  assert.match(card.values[0], /compact/);
  assert.equal(timers.size, 0);
  card.values[1](); // Compact card expands instead of navigating.
  card = render();
  assert.match(card.values[0], /expanded/);
  assert.equal(timers.size, 1);
  card.values[1](); // A second banner click must not open the order.
  card = render();
  assert.equal(opened, 0);
  assert.match(card.values[0], /compact/);
  assert.equal(timers.size, 0);
  card.values[1](); // Expand again to use the separate View order button.
  card = render();
  assert.match(card.values[0], /expanded/);
  const viewOrderIndex = card.strings.findIndex((part) => part.endsWith('className="toast-view" onClick='));
  assert.ok(viewOrderIndex >= 0);
  card.values[viewOrderIndex](); // Only the separate View order button navigates.
  card = render();
  assert.equal(opened, 1);
  assert.match(card.values[0], /compact/);
  assert.equal(timers.size, 0);
  cleanup?.();
  assert.equal(timers.size, 0);
});
