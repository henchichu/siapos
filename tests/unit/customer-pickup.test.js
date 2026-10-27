const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(root, "public/js/customer.js"), "utf8");

test("kiosk pickup wording follows order status and uses the cafe time zone", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/order/test", runScripts: "outside-only" });
  const w = dom.window;
  const order = { id: "test", orderNumber: 1, placedAt: "2026-10-27T04:58:00Z", tz: "America/Chicago", total: 3, items: [] };
  w.fetch = async () => ({ ok: true, json: async () => order });
  for (const file of ["react/umd/react.development.js", "react-dom/umd/react-dom.development.js", "htm/dist/htm.umd.js"]) {
    w.eval(fs.readFileSync(path.join(root, "node_modules", file), "utf8"));
  }
  w.eval(source.slice(0, source.lastIndexOf("ReactDOM.createRoot")) + 'const testRoot = ReactDOM.createRoot(document.getElementById("root")); window.renderOrder = key => testRoot.render(React.createElement(OrderDetails, { key, orderId: "test" }));');
  const time = iso => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: order.tz });
  const estimate = "Estimated ready time: " + time("2026-10-27T05:05:00Z");
  try {
    for (const [statusCode, completedAt, expected] of [
      [1, null, estimate], [2, null, estimate], [3, null, estimate],
      [4, null, "Ready for pickup"],
      [5, "2026-10-27T05:10:00Z", "Picked up at: " + time("2026-10-27T05:10:00Z")],
      [5, null, "Picked up"], [6, null, "Order cancelled"], [7, null, "Order refunded"],
      [7, "2026-10-27T05:10:00Z", "Picked up at: " + time("2026-10-27T05:10:00Z")],
    ]) {
      Object.assign(order, { statusCode, completedAt });
      w.renderOrder(statusCode + String(completedAt));
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(w.document.querySelector(".when")?.textContent, expected);
    }
  } finally { w.close(); }
});