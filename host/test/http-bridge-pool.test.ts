import assert from "node:assert/strict";
import test from "node:test";
import { VM, createHttpHooks } from "../src/index.ts";
import http from "node:http";
import type { AddressInfo } from "node:net";

test("http bridge evicts dispatcher when guest closes socket mid-stream during POST", async () => {
  let server: http.Server | undefined;
  let vm: VM | undefined;

  try {
    server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": "1000000000" // Tell curl to expect 1GB
      });

      const chunk = Buffer.alloc(1024 * 1024, "A");
      let isClosed = false;

      const interval = setInterval(() => {
        if (isClosed) {
          clearInterval(interval);
          res.end();
          return;
        }
        res.write(chunk);
      }, 1);

      req.on('data', () => {});

      req.on("close", () => {
        isClosed = true;
      });
      req.on("error", () => {
        isClosed = true;
      });
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    vm = new VM({
      httpHooks: createHttpHooks({
        allowAllIps: true,
        allowAllRequests: true,
        onRequest: async (req) => {
          const url = new URL(req.url);
          if (url.hostname === "10.0.2.2") {
            url.hostname = "127.0.0.1";
            return new Request(url.toString(), req);
          }
          return req;
        },
      }),
    });

    const url = `http://10.0.2.2:${port}/stream`;
    const hostHeader = `Host: 127.0.0.1:${port}`;

    // Create a 50MB dummy file for POST upload
    await vm.exec(["/bin/sh", "-c", "dd if=/dev/zero of=/tmp/large_file.bin bs=1M count=50"]);

    const exec1Promise = vm.exec([
      "/bin/sh",
      "-c",
      `timeout 1 curl -s -v --show-error --fail -H "${hostHeader}" -d "@/tmp/large_file.bin" ${url} -o /dev/null`,
    ]);

    const exec1 = await Promise.race([
      exec1Promise,
      new Promise<any>((resolve) =>
        setTimeout(
          () => resolve({ exitCode: -1, stderr: "TIMEOUT", stdout: "" }),
          15000,
        ),
      ),
    ]);

    assert.notEqual(exec1.exitCode, -1, "Guest client 1 hung the host");
    // timeout exits with 143 (SIGTERM)
    assert.notEqual(exec1.exitCode, 0, "Guest client 1 did not timeout");

    // Wait for TCP tear down
    await new Promise((r) => setTimeout(r, 1000));

    // Test the reuse of the connection. Because vanilla Gondolin fails to evict the
    // dispatcher, this second request will hang indefinitely. We wrap it in a strict timeout.
    const exec2Promise = vm.exec(
      [
        "/usr/bin/curl",
        "-s",
        "--show-error",
        "--fail",
        "-H",
        hostHeader,
        url,
        "-o",
        "/dev/null",
      ],
    );

    const exec2 = await Promise.race([
      exec2Promise,
      new Promise<any>((resolve) =>
        setTimeout(
          () => resolve({ exitCode: -1, stderr: "TIMEOUT", stdout: "" }),
          5000,
        ),
      ),
    ]);

    // If the bug exists, the second request hangs and we get -1.
    // We want the test to FAIL if the bug exists.
    assert.notEqual(
      exec2.exitCode,
      -1,
      "Second request hung, indicating a poisoned keep-alive dispatcher",
    );
    assert.equal(
      exec2.exitCode,
      0,
      "Second request should succeed with a fresh connection",
    );
  } finally {
    if (vm) await vm.close();
    if (server) {
      server.closeAllConnections();
      server.close();
    }
  }
});