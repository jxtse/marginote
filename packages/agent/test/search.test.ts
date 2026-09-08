import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { isPublicAddress, parseDdg, publicTarget, readableText } from "../src/search.js";

describe("search sandbox", () => {
  it("parses saved DDG results, entities, redirects and limits", async () => {
    const html = await readFile(new URL("./fixtures/ddg.html", import.meta.url), "utf8");
    expect(parseDdg(html)).toEqual([
      { title: "A paper & evidence", url: "https://example.com/paper", snippet: 'A useful summary "quoted".' },
      { title: "Reference", url: "https://example.org/reference", snippet: "Second result." },
    ]);
    expect(parseDdg(html, 1)).toHaveLength(1);
    expect(parseDdg("No results found")).toEqual([]);
    expect(() => parseDdg('<form id="challenge-form">captcha</form>')).toThrow(/unavailable/);
    expect(() => parseDdg("unexpected layout")).toThrow(/unavailable/);
    expect(readableText('<style>hide</style><script>evil()</script><p>Hello &amp; world &#x21;</p>')).toBe("Hello & world !");
  });
  it.each(["127.0.0.1", "0.0.0.0", "10.1.2.3", "100.64.1.1", "172.16.1.2", "192.168.0.3", "169.254.169.254", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2001:db8::1", "2002:7f00:1::1"])("blocks %s", address => { expect(isPublicAddress(address)).toBe(false); });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public %s", address => { expect(isPublicAddress(address)).toBe(true); });
  it("rejects private DNS answers, mixed answers, credentials and encoded IPs", async () => {
    const resolver = vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(publicTarget("https://example.com", resolver)).rejects.toThrow(/blocked/);
    await expect(publicTarget("http://2130706433")).rejects.toThrow(/blocked/);
    await expect(publicTarget("http://[::ffff:7f00:1]")).rejects.toThrow(/blocked/);
    await expect(publicTarget("file:///etc/passwd")).rejects.toThrow(/HTTP/);
    await expect(publicTarget("http://user:pass@example.com")).rejects.toThrow(/HTTP/);
    resolver.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    expect(await publicTarget("https://example.com", resolver)).toMatchObject({ address: "8.8.8.8", family: 4 });
  });
});
