const assert = require('node:assert/strict');
process.env.DB_PASSWORD_FILE ||= 'sql/secrets/app_user_password.txt';
const pool = require('../../server/database/connection');

(async () => {
  const base = process.env.TEST_BASE_URL || 'http://localhost:3000';
  const login = await fetch(base + '/api/login/pin', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ employeeNumber: '10420001', pin: '111111' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function call(path, body, status = 200) {
    const response = await fetch(base + '/api/settings/' + path, {
      method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }
  const name = 'Settings test ' + Date.now();
  let roleId, categoryId, locationId;
  try {
    const general = await call('general');
    await call('business', { ...general.business, includesTax: !!general.business.includesTax });
    await call('refunds', { amount: general.business.amount, days: general.business.days });
    await call('roles', { name, opensTo: 'SHIFT', active: true, permissions: [14] });
    const role = (await call('roles')).roles.find(r => r.name === name);
    roleId = role.id;
    await call('roles', { ...role, active: true, permissions: [5], opensTo: 'KITCHEN' });
    await call('roles', { ...role, active: false });
    await call('categories', { name });
    categoryId = (await call('general')).categories.find(c => c.name === name).id;
    await call('categories', { id: categoryId, name: name + ' renamed', active: false });
    await call('locations', {
      name, address: 'Test address', phone: '', timeZone: 'America/Chicago', active: true, online: false,
      rates: Object.fromEntries(general.taxes.map(t => [t.id, '0'])), registers: [{ name: 'Counter' }],
    });
    const location = (await call('general')).locations.find(l => l.name === name);
    locationId = location.id;
    assert.equal(location.registers.length, 1);
    await call('locations', { ...location, active: true, online: true, name: name + ' updated' });
    // The creator is assigned to the location, so deactivation must be blocked.
    await call('locations', { ...location, active: false, online: false }, 400);
    console.log('PASS settings writes: business, refunds, roles, categories, locations, taxes, registers and assigned-location protection');
  } finally {
    if (roleId) await pool.query('DELETE FROM Role WHERE RoleID=?', [roleId]);
    if (categoryId) await pool.query('DELETE FROM Category WHERE CategoryID=?', [categoryId]);
    if (locationId) {
      await pool.query('DELETE FROM EmployeeLocation WHERE LocationID=?', [locationId]);
      await pool.query('DELETE FROM Register WHERE LocationID=?', [locationId]);
      await pool.query('DELETE FROM LocationTaxRate WHERE LocationID=?', [locationId]);
      await pool.query('DELETE FROM Location WHERE LocationID=?', [locationId]);
    }
    await pool.end();
  }
})().catch(error => { console.error(error); process.exit(1); });
