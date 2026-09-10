import { isIP } from "node:net";
// 纯网络地址分类（manager 与 AI 发现模块共用；无依赖叶子）。
export function approvedDiscoveryHost(host) {
  return (
    loopbackHost(host) ||
    privateHost(host) ||
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}\.)*local$/iu.test(host)
  );
}

export function loopbackHost(host) {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function privateHost(host) {
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
    );
  }
  if (version === 6) {
    const normalized = host.toLowerCase();
    return normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized);
  }
  return false;
}

export function urlHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

