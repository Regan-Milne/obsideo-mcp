// Preloaded with `node --import` into a server process under test: refuses any
// outbound TCP connection or DNS lookup that is not loopback, so a test can
// never reach Obsideo (or anything else) by accident.
//
// Adapted from the guard in obsideo-agent-bridge PR #13 (claude-code), with a
// DNS check added: the original covered TCP only.
import net from "node:net";
import dns from "node:dns";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]);

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a0 = args[0];
  let host;
  if (a0 && typeof a0 === "object" && !Array.isArray(a0)) {
    if (a0.path) return origConnect.apply(this, args); // pipe / unix socket, not network
    host = a0.host;
  } else if (typeof args[1] === "string") {
    host = args[1];
  }
  if (host !== undefined && !LOOPBACK.has(String(host))) {
    const err = new Error(`loopback_guard blocked outbound connection to ${host}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};

const origLookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
  if (!LOOPBACK.has(String(hostname))) {
    const cb = rest[rest.length - 1];
    const err = Object.assign(new Error(`loopback_guard blocked DNS lookup of ${hostname}`), { code: "ENOTFOUND" });
    if (typeof cb === "function") return process.nextTick(() => cb(err));
    throw err;
  }
  return origLookup.call(this, hostname, ...rest);
};
