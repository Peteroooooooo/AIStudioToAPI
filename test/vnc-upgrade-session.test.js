const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");

const ProxyServerSystem = require("../src/core/ProxyServerSystem");

async function openUpgrade(port, sessionId) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        let response = "";
        socket.setTimeout(3000, () => socket.destroy(new Error("Upgrade timed out")));
        socket.on("error", reject);
        socket.on("data", chunk => {
            response += chunk.toString();
            if (response.includes("\r\n\r\n")) socket.end();
        });
        socket.on("close", () => resolve(response));
        socket.on("connect", () => {
            const query = sessionId === null ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
            socket.write(
                `GET /vnc${query} HTTP/1.1\r\n` +
                    `Host: 127.0.0.1:${port}\r\n` +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Sec-WebSocket-Version: 13\r\n" +
                    "Sec-WebSocket-Key: dGVzdC1rZXktMTIzNDU2\r\n\r\n"
            );
        });
    });
}

test("VNC upgrade refuses stale or missing session IDs", async t => {
    const system = Object.create(ProxyServerSystem.prototype);
    system.config = { host: "127.0.0.1", httpPort: 0 };
    system.logger = { error() {}, info() {}, warn() {} };
    system._createExpressApp = () => (_request, response) => response.end();
    system.webRoutes = {
        authRoutes: {
            createAuth: { matchesSessionId: value => value === "current-session" },
            getClientIP: () => "127.0.0.1",
        },
        sessionParser: (request, _response, next) => {
            request.session = { isAuthenticated: true };
            next();
        },
    };
    await system._startHttpServer();
    t.after(() => system.httpServer.close());
    const port = system.httpServer.address().port;

    assert.match(await openUpgrade(port, null), /^HTTP\/1\.1 403 Forbidden/);
    assert.match(await openUpgrade(port, "older-session"), /^HTTP\/1\.1 403 Forbidden/);
});
