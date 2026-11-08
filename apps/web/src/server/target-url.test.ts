import { describe, expect, it } from "vitest";
import { assertPublicTarget, isPrivateAddress, rejectTargetUrl, type LookupFn } from "./target-url";

const fake = (...addresses: string[]): LookupFn => async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.168.1.1", "198.18.0.1", "198.19.255.255",
    "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1",
    "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:192.168.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::1",
    "not-an-ip",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    "8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.0.1.1", "198.17.255.255",
    "198.20.0.1", "223.255.255.255", "93.184.216.34",
    "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "fec0::1".replace("fec0", "2a00"),
  ])("allows %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("rejectTargetUrl", () => {
  it("rejects non-https, localhost, private literals and userinfo", () => {
    expect(rejectTargetUrl("http://example.com")).toMatch(/HTTPS/);
    expect(rejectTargetUrl("https://localhost/x")).toBeTruthy();
    expect(rejectTargetUrl("https://foo.internal")).toBeTruthy();
    expect(rejectTargetUrl("https://127.1/")).toBeTruthy();
    expect(rejectTargetUrl("https://[::1]/")).toBeTruthy();
    expect(rejectTargetUrl("https://[::ffff:10.0.0.1]/")).toBeTruthy();
    expect(rejectTargetUrl("https://user:pw@example.com/")).toMatch(/credentials/);
    expect(rejectTargetUrl("https://user@example.com/")).toMatch(/credentials/);
    expect(rejectTargetUrl("not a url")).toBe("invalid URL");
  });
  it("allows public hosts on any port", () => {
    expect(rejectTargetUrl("https://example.com:9443/v1")).toBeNull();
    expect(rejectTargetUrl("https://8.8.8.8/")).toBeNull();
  });
});

describe("assertPublicTarget", () => {
  it("allows a hostname resolving only to public addresses", async () => {
    expect(await assertPublicTarget("https://api.example.com/x", { lookup: fake("93.184.216.34", "2606:4700::1") })).toBeNull();
  });
  it("rejects when any resolved address is private (rebinding-ish mixed answers)", async () => {
    expect(await assertPublicTarget("https://evil.example.com", { lookup: fake("93.184.216.34", "10.0.0.5") })).toMatch(/private/);
    expect(await assertPublicTarget("https://evil.example.com", { lookup: fake("8.8.8.8", "::1") })).toMatch(/private/);
    expect(await assertPublicTarget("https://evil.example.com", { lookup: fake("169.254.169.254") })).toMatch(/private/);
    expect(await assertPublicTarget("https://evil.example.com", { lookup: fake("::ffff:127.0.0.1") })).toMatch(/private/);
    expect(await assertPublicTarget("https://evil.example.com", { lookup: fake("100.64.1.1") })).toMatch(/private/);
  });
  it("rejects on DNS failure, empty answer, and timeout", async () => {
    const boom: LookupFn = async () => { throw new Error("ENOTFOUND"); };
    expect(await assertPublicTarget("https://nope.example.com", { lookup: boom })).toBe("DNS resolution failed");
    expect(await assertPublicTarget("https://nope.example.com", { lookup: fake() })).toMatch(/no addresses/);
    const hang: LookupFn = () => new Promise(() => {});
    expect(await assertPublicTarget("https://slow.example.com", { lookup: hang, timeoutMs: 20 })).toMatch(/timed out/);
  });
  it("runs sync checks first and never calls DNS for rejected or literal URLs", async () => {
    let calls = 0;
    const spy: LookupFn = async () => { calls++; return [{ address: "8.8.8.8", family: 4 }]; };
    expect(await assertPublicTarget("http://example.com", { lookup: spy })).toMatch(/HTTPS/);
    expect(await assertPublicTarget("https://u:p@example.com", { lookup: spy })).toMatch(/credentials/);
    expect(await assertPublicTarget("https://10.0.0.1", { lookup: spy })).toBeTruthy();
    expect(await assertPublicTarget("https://8.8.8.8", { lookup: spy })).toBeNull();
    expect(calls).toBe(0);
  });
});
