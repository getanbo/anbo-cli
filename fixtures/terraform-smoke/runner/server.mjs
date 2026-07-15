import { createServer } from "node:http";

const server = createServer((request, response) => {
  const ok = request.url === "/healthz";
  response.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(ok ? { status: "ready" } : { error: "not_found" }));
});
server.listen(8080, "0.0.0.0", () => process.stdout.write(`${JSON.stringify({ event: "runner.ready", port: 8080 })}\n`));
