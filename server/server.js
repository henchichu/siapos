const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const publicDirectory = path.resolve(__dirname, "../public");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function handleRequest(request, response) {
  const requestUrl = new URL(
    request.url,
    `http://${request.headers.host || "localhost"}`
  );

  // Docker and deployment health check
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
    });

    response.end(
      JSON.stringify({
        status: "ok",
        application: "SIAPOS",
      })
    );

    return;
  }

  if (request.method !== "GET") {
    response.writeHead(405, {
      "Content-Type": "application/json; charset=utf-8",
    });

    response.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const requestedPage =
    requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;

  const relativePath = decodeURIComponent(requestedPage).replace(/^\/+/, "");
  const filePath = path.resolve(publicDirectory, relativePath);

  // Prevent requests from accessing files outside public/
  if (
    filePath !== publicDirectory &&
    !filePath.startsWith(`${publicDirectory}${path.sep}`)
  ) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();

    response.writeHead(200, {
      "Content-Type":
        contentTypes[extension] || "application/octet-stream",
    });

    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Page not found");
      return;
    }

    console.error(error);
    response.writeHead(500, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Internal server error");
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, HOST, () => {
  console.log(`SIAPOS is running at http://localhost:${PORT}`);
});