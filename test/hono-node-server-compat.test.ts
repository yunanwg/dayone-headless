import { expect, test } from "bun:test";

test("@hono/node-server override serves a Web Response under Node", async () => {
  const source = `
    import { serve } from "@hono/node-server";
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      overrideGlobalObjects: false,
      fetch: (request) => new Response(new URL(request.url).pathname),
    });
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const response = await fetch("http://127.0.0.1:" + address.port + "/synthetic");
    const body = await response.text();
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    if (response.status !== 200 || body !== "/synthetic") process.exit(1);
  `;
  const child = Bun.spawn(["node", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});
