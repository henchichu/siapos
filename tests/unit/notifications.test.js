const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const customer = require('../../server/customer');
const pool = require('../../server/database/connection');
const { handleErrors } = require('../../server/errors');
let server, base;
const alerts = [{ id: 1, customerId: 'owner', channelCode: 3, readAt: null },
  { id: 2, customerId: 'owner', channelCode: 1, readAt: null }];
const originalQuery = pool.query;
const cookies = {};
test.before(async () => {
  pool.query = async (sql, params) => {
    assert.match(sql, /CustomerID = \?/);
    if (sql.startsWith('UPDATE')) {
      const alert = alerts.find((a) => String(a.id) === params[0] && a.customerId === params[1]);
      if (alert) alert.readAt ||= '2026-11-07T19:00:00Z';
      return [{ affectedRows: alert ? 1 : 0 }];
    }
    assert.match(sql, /o\.ChannelCode = 3/);
    return [alerts.filter((a) => a.customerId === params[0] && a.channelCode === 3).map((a) => ({ ...a }))];
  };
  for (const id of ['owner', 'other']) customer.create({ cookie: (name, value) => { cookies[id] = `${name}=${value}`; } }, { customerId: id });
  const app = express();
  app.use('/api', express.json(), customer.router);
  app.use(handleErrors);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/api/customer/notifications`;
});
test.after(async () => { pool.query = originalQuery; if (server) await new Promise((resolve) => server.close(resolve)); await pool.end(); });
const request = (who, suffix = '', method = 'GET') => fetch(base + suffix, { method, headers: { cookie: cookies[who] || '' } });
test('anonymous requests are rejected', async () => {
  assert.equal((await request('anonymous')).status, 401);
  assert.equal((await request('anonymous', '/1/read', 'POST')).status, 401);
});
test('customers only list their own customer-app alerts, excluding register orders', async () => {
  assert.equal((await (await request('owner')).json()).alerts.length, 1);
  assert.deepEqual((await (await request('other')).json()).alerts, []);
});
test('customers cannot mark another customer alert read', async () => {
  assert.equal((await request('other', '/1/read', 'POST')).status, 404);
  assert.equal(alerts[0].readAt, null);
});
test('mark as read persists and repeated requests succeed', async () => {
  assert.equal((await request('owner', '/invalid/read', 'POST')).status, 404);
  assert.equal((await request('owner', '/1/read', 'POST')).status, 200);
  const readAt = (await (await request('owner')).json()).alerts[0].readAt;
  assert.ok(readAt);
  assert.equal((await request('owner', '/1/read', 'POST')).status, 200);
  assert.equal((await (await request('owner')).json()).alerts[0].readAt, readAt);
});
