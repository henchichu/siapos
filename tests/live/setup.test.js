// Public business sign-up (POST /api/setup), closed once the app has a business, and keeping businesses apart in one database.
// The app allows one business, so these tests open sign-up by replacing setup.signupClosed (the demo business is already there).
// Every business a test creates is deleted afterwards, with everything in it.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { start, client, pool, removeBusiness } = require("./env");
const setup = require("../../server/setup");
const router = require("../../server/router");

const realClosed = setup.signupClosed;
let env;
const made = []; // business ids to delete
const tag = crypto.randomBytes(3).toString("hex");
test.before(async () => { env = await start(); setup.signupClosed = async () => false; });
test.beforeEach(() => { setup.resetSetupLimit(); router.resetLookupLimits(); });
test.after(async () => {
  try { for (const id of made) await removeBusiness(id); } finally { env.server.close(); await pool.end(); }
});

const form = (over = {}) => ({
  business: { name: `Test Shop ${tag}`, email: "Hello@Example.com", phone: "312-555-0199", includesTax: false, ...over.business },
  location: { name: "Downtown", timeZone: "America/Denver", address: "1 Main St, Denver, CO 80202", phone: "", registers: ["Front counter", "Drive-thru"], ...over.location },
  owner: { firstName: "Dana", lastName: "Reyes", email: `dana.${tag}@example.com`, pin: "481516", pinConfirm: "481516", ...over.owner },
  agreed: true,
  ...over.top,
});

// Signs up a business and gives back its owner's browser (signed in with the new number, as the owner does next) and the ids
async function signUp(over) {
  const r = await client(env.base).call("/setup", form(over));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const owner = await signIn(r.body.employeeNumber, form(over).owner.pin);
  const [[emp]] = await pool.query("SELECT EmployeeID AS id, BusinessID AS businessId FROM Employee WHERE EmployeeNumber = ?", [r.body.employeeNumber]);
  made.push(emp.businessId);
  return { owner, number: r.body.employeeNumber, body: r.body, employeeId: emp.id, businessId: emp.businessId };
}
const signIn = async (number, pin) => { const c = client(env.base); assert.equal((await c.call("/login/pin", { employeeNumber: number, pin })).status, 200); return c; };

test("sign-up creates the business, owner, café and defaults in one go, without signing the owner in", async () => {
  const bare = client(env.base);
  assert.equal((await bare.call("/setup", form({ business: { name: `No session ${tag}` }, owner: { email: `nosession.${tag}@example.com` } }))).status, 200);
  assert.equal((await bare.call("/session")).status, 401, "the sign-up leaves no session");
  const [[stray]] = await pool.query("SELECT BusinessID AS id FROM Business WHERE Name = ?", [`No session ${tag}`]);
  made.push(stray.id);

  const { owner, number, body, businessId, employeeId } = await signUp();
  assert.match(number, /^[1-9]\d{7}$/, "8 digits, no leading zero");
  assert.deepEqual([body.firstName, body.businessName, body.redirect], ["Dana", `Test Shop ${tag}`, "/login.html"]);

  const me = (await owner.call("/session")).body;
  assert.deepEqual([me.employeeName, me.roleName, me.locationName, me.registerName], ["Dana Reyes", "Owner", "Downtown", "Drive-thru"]);
  assert.ok(me.nav.includes("Settings") && me.nav.includes("Employees"), "an owner's full menu");

  const [[b]] = await pool.query("SELECT Name, ContactEmail, ContactPhone, PricesIncludeTax FROM Business WHERE BusinessID = ?", [businessId]);
  assert.deepEqual([b.Name, b.ContactEmail, b.ContactPhone, !!b.PricesIncludeTax], [`Test Shop ${tag}`, "hello@example.com", "312-555-0199", false]);
  const [[role]] = await pool.query("SELECT r.Name, r.IsOwner, r.OpensTo, (SELECT COUNT(*) FROM RolePermission rp WHERE rp.RoleID = r.RoleID) AS grants FROM Role r WHERE r.BusinessID = ?", [businessId]);
  assert.deepEqual([role.Name, !!role.IsOwner, role.OpensTo, role.grants], ["Owner", true, "REGISTER", 0], "like the demo owner: IsOwner, no permission rows");
  const [[loc]] = await pool.query("SELECT LocationID AS id, Name, TimeZone, Address, Phone, AcceptsOnlineOrders FROM Location WHERE BusinessID = ?", [businessId]);
  assert.deepEqual([loc.Name, loc.TimeZone, loc.Address, loc.Phone, !!loc.AcceptsOnlineOrders], ["Downtown", "America/Denver", "1 Main St, Denver, CO 80202", null, false]);
  const [regs] = await pool.query("SELECT Name FROM Register WHERE LocationID = ? ORDER BY Name", [loc.id]);
  assert.deepEqual(regs.map((r) => r.Name), ["Drive-thru", "Front counter"]);
  const [[cred]] = await pool.query("SELECT PinHash, PasswordHash FROM EmployeeCredential WHERE EmployeeID = ?", [employeeId]);
  assert.ok(cred.PinHash.startsWith("scrypt$") && !cred.PinHash.includes("481516") && cred.PasswordHash === null, "the PIN hashed like every other");
  const [[assigned]] = await pool.query("SELECT COUNT(*) AS n FROM EmployeeLocation WHERE EmployeeID = ? AND LocationID = ? AND Active", [employeeId, loc.id]);
  assert.equal(assigned.n, 1);
  const [taxes] = await pool.query("SELECT Name FROM TaxCategory WHERE BusinessID = ? ORDER BY Name", [businessId]);
  assert.deepEqual(taxes.map((t) => t.Name), ["Exempt", "Standard"]);
  const [[rates]] = await pool.query("SELECT COUNT(*) AS n FROM LocationTaxRate WHERE BusinessID = ?", [businessId]);
  assert.equal(rates.n, 0, "no tax rates: the owner sets them");
  const [periods] = await pool.query(
    `SELECT DATE_FORMAT(StartDate, '%Y-%m-%d') AS s, DATEDIFF(EndDate, StartDate) AS len,
            StartDate = DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', 'America/Denver')) AS today FROM PayPeriod WHERE BusinessID = ? ORDER BY StartDate`, [businessId]);
  assert.equal(periods.length, 26);
  assert.ok(periods[0].today && periods.every((p) => p.len === 13), "two weeks each, from the café's today");
  assert.ok(periods.every((p, i) => !i || Date.parse(p.s) - Date.parse(periods[i - 1].s) === 14 * 864e5), "back to back");
  const [tiers] = await pool.query("SELECT Name, MinimumPoints FROM MembershipTier WHERE BusinessID = ?", [businessId]);
  assert.deepEqual(tiers.map((t) => [t.Name, t.MinimumPoints]), [["Bean", 0]]);

  await signIn(number, "481516"); // and the sign-in page knows them too
  assert.equal((await owner.call("/rewards/members", { firstName: "Pat", email: `pat.${tag}@example.com` })).status, 200, "the Bean tier lets members enroll");
  // Selling is refused until the owner sets this café's tax rates
  const product = await owner.call("/products", { name: "Drip coffee" });
  const standard = (await owner.call(`/products/${product.body.id}/sizes`)).body.taxCategories.find((t) => t.name === "Standard");
  const size = await owner.call(`/products/${product.body.id}/sizes`, { name: "Regular", sku: `DRIP-${tag}`, price: "2.50", taxCategoryId: standard.id });
  const price = await owner.call("/register/price", { items: [{ key: "a", variantId: size.body.id, quantity: 1 }] });
  assert.equal(price.status, 409);
  assert.match(price.body.error, /No tax rate is set for Drip coffee/);
});

test("each step is checked like the form, the first step with problems is named, and nothing is written", async () => {
  const [[before]] = await pool.query("SELECT COUNT(*) AS n FROM Business");
  const cases = [
    [{ business: { name: " " } }, 1, /^Enter your business name\.$/],
    [{ business: { includesTax: undefined } }, 1, /include tax/],
    [{ business: { email: "not-an-email" } }, 1, /valid email/],
    [{ business: { phone: "123" } }, 1, /phone number/],
    [{ location: { name: "" } }, 2, /^Give your first location a name\.$/],
    [{ location: { timeZone: "Europe/London" } }, 2, /time zone from the list/],
    [{ location: { registers: [] } }, 2, /^Add at least one register\.$/],
    [{ location: { registers: ["Front", "front"] } }, 2, /its own name/],
    [{ location: { registers: ["Front", " "] } }, 2, /Give each register a name/],
    [{ owner: { firstName: "D4na" } }, 3, /first name/],
    [{ owner: { email: "" } }, 3, /valid email/],
    [{ owner: { pin: "12345", pinConfirm: "12345" } }, 3, /6-digit PIN/],
    [{ owner: { pinConfirm: "481517" } }, 3, /PINs don't match/],
    [{ top: { agreed: false } }, 4, /Agree to the terms/],
  ];
  for (const [over, step, message] of cases) {
    setup.resetSetupLimit();
    const r = await client(env.base).call("/setup", form(over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(r.body.step, step, JSON.stringify(over));
    assert.match(r.body.error, message);
  }
  const both = await client(env.base).call("/setup", form({ business: { name: "" }, owner: { pin: "1" } }));
  assert.equal(both.body.step, 1, "the earliest step with a problem comes back first");
  const [[after]] = await pool.query("SELECT COUNT(*) AS n FROM Business");
  assert.equal(after.n, before.n);
});

test("a failure partway through rolls everything back", async () => {
  const realRandom = crypto.randomInt;
  crypto.randomInt = () => 10420001; // Maya's number, every try: the employee insert fails after the business, café and registers
  try {
    const r = await client(env.base).call("/setup", form({ business: { name: `Rollback ${tag}` }, location: { name: `Rollback ${tag}` } }));
    assert.equal(r.status, 409);
  } finally { crypto.randomInt = realRandom; }
  const [[b]] = await pool.query("SELECT COUNT(*) AS n FROM Business WHERE Name = ?", [`Rollback ${tag}`]);
  const [[l]] = await pool.query("SELECT COUNT(*) AS n FROM Location WHERE Name = ?", [`Rollback ${tag}`]);
  assert.deepEqual([b.n, l.n], [0, 0], "no business, café or registers left behind");
});

test("sign-up is rate limited per address", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await client(env.base).call("/setup", form({ top: { agreed: false } }))).status, 400);
  const sixth = await client(env.base).call("/setup", form());
  assert.equal(sixth.status, 429, "the 6th try in an hour from one address");
});

test("sign-up is closed once the app has a business: refused, nothing written, pages told", async () => {
  await signUp(); // with the check open, so a business is certainly there whatever the database held before
  setup.signupClosed = realClosed;
  try {
    const [[before]] = await pool.query("SELECT COUNT(*) AS n FROM Business");
    const r = await client(env.base).call("/setup", form());
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /already has a business/);
    const [[after]] = await pool.query("SELECT COUNT(*) AS n FROM Business");
    assert.equal(after.n, before.n);
    assert.deepEqual((await client(env.base).call("/setup/open")).body, { open: false });
  } finally { setup.signupClosed = async () => false; }
});

test("the sign-in name lookup is rate limited", async () => {
  const c = client(env.base);
  for (let i = 0; i < 10; i++) assert.equal((await c.call("/login/employee", { employeeNumber: "10420003" })).status, 200);
  const r = await c.call("/login/employee", { employeeNumber: "10420003" });
  assert.equal(r.status, 429, "the 11th lookup in a minute");
});

// The two-way check: a second business's owner can't see or change Brewbean, and Brewbean's owner can't see or change theirs
test("businesses are kept apart, both ways", async () => {
  const other = await signUp({ business: { name: `Other ${tag}` }, owner: { email: `other.${tag}@example.com` } });
  const b = other.owner;
  const maya = await signIn("10420001", "111111");
  const [[order]] = await pool.query("SELECT OrderID AS id FROM Orders WHERE BusinessID = 'biz-brewbean' AND CustomerID = 'cus-chloe' ORDER BY OrderDateTime DESC LIMIT 1");
  const [[entry]] = await pool.query("SELECT TimeEntryID AS id, TimeEntryStatusCode AS status FROM TimeEntry WHERE BusinessID = 'biz-brewbean' AND TimeEntryStatusCode = 2 LIMIT 1");
  const BREWBEAN = /Brewbean|loc-campus|loc-downtown|emp-leo|Leo|cus-chloe|Chloe|prd-latte|Latte|cat-coffee|stk-beans|sup-roaster|mg-milk|promo-morning/;
  const clean = (body, what) => assert.ok(!BREWBEAN.test(JSON.stringify(body)), `${what} shows nothing of Brewbean: ${JSON.stringify(body).slice(0, 200)}`);
  const refused = (r, what) => assert.ok([400, 403, 404, 409].includes(r.status), `${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

  // What the other owner sees: only their own business
  for (const path of ["/session", "/reports/options", "/reports/live?location=all", "/reports/sales-by-day?location=all", "/employees", "/products/list",
    "/option-groups", "/promotions", "/orders", "/rewards/members", "/settings/general", "/settings/roles", "/inventory", "/team/timecards", "/attention", "/locations"]) {
    const r = await b.call(path);
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body).slice(0, 120)}`);
    clean(r.body, path);
  }
  // ...and what they can't reach or change
  refused(await b.call("/reports/sales-by-day?location=loc-campus"), "Brewbean's report");
  refused(await b.call("/orders?locationId=loc-campus"), "Brewbean's orders");
  refused(await b.call(`/orders/${order.id}`), "a Brewbean order");
  refused(await b.call(`/rewards/orders/${order.id}`), "a Brewbean order through Rewards");
  refused(await b.call("/rewards/members/cus-chloe"), "a Brewbean member");
  refused(await b.call("/rewards/members/cus-chloe", { firstName: "Hacked", email: "x@example.com" }), "editing a Brewbean member");
  refused(await b.call("/rewards/members/cus-chloe/active", { active: false }), "deactivating a Brewbean member");
  refused(await b.call("/employees/emp-leo", { firstName: "Hacked" }), "editing a Brewbean employee");
  refused(await b.call("/employees/emp-leo/active", { active: false }), "deactivating a Brewbean employee");
  refused(await b.call("/employees/emp-leo/unlock", {}), "unlocking a Brewbean employee");
  refused(await b.call("/products/prd-latte", { name: "Hacked" }), "editing a Brewbean product");
  refused(await b.call("/products/prd-latte/active", { active: false }), "hiding a Brewbean product");
  refused(await b.call("/products/prd-latte/sizes"), "a Brewbean product's sizes");
  refused(await b.call("/sizes/var-amer-s", { name: "Hacked", sku: "X", price: "1", taxCategoryId: "x" }), "editing a Brewbean size");
  refused(await b.call("/sizes/var-amer-s/recipe"), "a Brewbean recipe");
  refused(await b.call("/option-groups/mg-milk", { name: "Hacked", min: 0, max: 1, options: [] }), "editing a Brewbean option group");
  refused(await b.call("/promotions/promo-morning-pastry/end", {}), "ending a Brewbean promotion");
  refused(await b.call("/inventory?locationId=loc-campus"), "Brewbean's stock");
  refused(await b.call("/inventory/item/stk-beans/active", { active: false }), "deactivating Brewbean stock");
  refused(await b.call("/inventory/supplier/sup-roaster/active", { active: false }), "deactivating a Brewbean supplier");
  refused(await b.call("/settings/categories", { id: "cat-coffee", name: "Hacked", active: true }), "renaming a Brewbean category");
  refused(await b.call("/settings/locations", { id: "loc-campus", name: "Hacked", timeZone: "America/Chicago", active: true, online: false, registers: [{ name: "X" }] }), "editing a Brewbean café");
  refused(await b.call("/settings/roles", { id: "role-manager", name: "Hacked", active: true, permissions: [1] }), "editing a Brewbean role");
  refused(await b.call(`/team/timecards/${entry.id}/approve`, {}), "approving a Brewbean timecard");
  refused(await b.call("/team/pay-periods/pp-curr/close", {}), "closing a Brewbean pay period");
  refused(await b.call(`/kitchen/orders/${order.id}/start`, {}), "a Brewbean kitchen ticket");
  refused(await b.call("/locations/switch", { locationId: "loc-campus" }), "switching to a Brewbean café");
  refused(await b.call("/register/price", { items: [{ key: "a", variantId: "var-amer-s", quantity: 1 }] }), "selling a Brewbean product");

  // A manager's lockout isn't another business's to run up: Leo's number with wrong PINs leaves his account alone
  const discount = { applyTo: "order", type: "percent", value: 10, reason: "Complaint" };
  for (let i = 0; i < 6; i++) {
    const r = await b.call("/register/discount/authorize", { discount, managerNumber: "10420002", managerPin: "000000" });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /^Unauthorized\./);
  }
  const [[leo]] = await pool.query("SELECT FailedPinAttempts AS n, LockedUntil AS until FROM EmployeeCredential WHERE EmployeeID = 'emp-leo'");
  assert.deepEqual([leo.n, leo.until], [0, null], "no tries counted against Leo");

  // Brewbean is untouched
  const [[latte]] = await pool.query("SELECT Name, Active FROM Product WHERE ProductID = 'prd-latte'");
  const [[leoRow]] = await pool.query("SELECT FirstName, Active FROM Employee WHERE EmployeeID = 'emp-leo'");
  const [[coffee]] = await pool.query("SELECT Name FROM Category WHERE CategoryID = 'cat-coffee'");
  const [[campus]] = await pool.query("SELECT Name FROM Location WHERE LocationID = 'loc-campus'");
  const [[card]] = await pool.query("SELECT TimeEntryStatusCode AS status FROM TimeEntry WHERE TimeEntryID = ?", [entry.id]);
  assert.equal(card.status, entry.status, "the timecard is still waiting");
  assert.deepEqual([latte.Name, !!latte.Active, leoRow.FirstName, !!leoRow.Active, coffee.Name, campus.Name], ["Latte", true, "Leo", true, "Coffee", "Brewbean Campus"]);

  // The reverse: give the other business some data, then Brewbean's owner tries to reach it
  assert.equal((await b.call("/settings/categories", { name: `Their category ${tag}` })).status, 200);
  const product = (await b.call("/products", { name: `Their product ${tag}` })).body.id;
  await b.call("/rewards/members", { firstName: "Their", lastName: "Member", email: `their.${tag}@example.com` });
  const [[theirCat]] = await pool.query("SELECT CategoryID AS id FROM Category WHERE BusinessID = ?", [other.businessId]);
  const [[theirLoc]] = await pool.query("SELECT LocationID AS id FROM Location WHERE BusinessID = ?", [other.businessId]);
  const [[theirRole]] = await pool.query("SELECT RoleID AS id FROM Role WHERE BusinessID = ?", [other.businessId]);
  const [[theirMember]] = await pool.query("SELECT CustomerID AS id FROM Customer WHERE BusinessID = ?", [other.businessId]);
  const [[theirTax]] = await pool.query("SELECT TaxCategoryID AS id FROM TaxCategory WHERE BusinessID = ? LIMIT 1", [other.businessId]);
  const THEIRS = new RegExp([`Other ${tag}`, tag, other.employeeId, theirLoc.id, theirRole.id, theirMember.id, product, theirCat.id, "Dana"].join("|"));
  for (const path of ["/reports/options", "/employees", "/products/list", "/rewards/members", "/settings/general", "/settings/roles", "/orders", "/inventory", "/locations"]) {
    const r = await maya.call(path);
    assert.equal(r.status, 200, path);
    assert.ok(!THEIRS.test(JSON.stringify(r.body)), `${path} shows nothing of the other business`);
  }
  refused(await maya.call(`/employees/${other.employeeId}`, { firstName: "Hacked" }), "editing their owner");
  refused(await maya.call(`/employees/${other.employeeId}/active`, { active: false }), "deactivating their owner");
  refused(await maya.call(`/products/${product}`, { name: "Hacked" }), "editing their product");
  refused(await maya.call(`/products/${product}/sizes`, { name: "X", sku: `X-${tag}`, price: "1", taxCategoryId: theirTax.id }), "adding a size to their product");
  refused(await maya.call(`/rewards/members/${theirMember.id}`), "their member");
  refused(await maya.call(`/rewards/members/${theirMember.id}/active`, { active: false }), "deactivating their member");
  refused(await maya.call("/settings/categories", { id: theirCat.id, name: "Hacked", active: true }), "renaming their category");
  refused(await maya.call("/settings/locations", { id: theirLoc.id, name: "Hacked", timeZone: "America/Chicago", active: true, online: false, registers: [{ name: "X" }] }), "editing their café");
  refused(await maya.call("/settings/roles", { id: theirRole.id, name: "Hacked", active: true, permissions: [] }), "editing their owner role");
  refused(await maya.call("/locations/switch", { locationId: theirLoc.id }), "switching to their café");
  refused(await maya.call(`/reports/sales-by-day?location=${theirLoc.id}`), "their report");
  const [[theirName]] = await pool.query("SELECT p.Name AS product, c.Name AS category, e.FirstName AS owner, cu.FirstName AS member FROM Product p, Category c, Employee e, Customer cu WHERE p.ProductID = ? AND c.CategoryID = ? AND e.EmployeeID = ? AND cu.CustomerID = ?",
    [product, theirCat.id, other.employeeId, theirMember.id]);
  assert.deepEqual(Object.values(theirName), [`Their product ${tag}`, `Their category ${tag}`, "Dana", "Their"], "their data is untouched");
});
