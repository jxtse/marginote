import { afterEach, expect, it, vi } from "vitest";
import { LatexPreview, sourceHash } from "../src/latex-preview.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("debounces edits, ignores stale responses and revokes obsolete URLs", async () => {
  vi.useFakeTimers();
  const pending: Array<(response: Response) => void> = [];
  const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const show = vi.fn();
  const controller = new LatexPreview(show, fetcher);
  controller.schedule("main.tex", "one");
  controller.schedule("main.tex", "two");
  await vi.advanceTimersByTimeAsync(700);
  expect(fetcher).toHaveBeenCalledTimes(1);
  controller.schedule("main.tex", "three");
  await vi.advanceTimersByTimeAsync(700);
  pending[0]!(new Response("%PDF-old", { headers: { "x-source-hash": await sourceHash("two") } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(create).not.toHaveBeenCalled();
  pending[1]!(new Response("%PDF-new", { headers: { "x-source-hash": await sourceHash("three") } }));
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(show).toHaveBeenLastCalledWith({ status: "ready", url: "blob:first" }));
  controller.reset();
  expect(revoke).toHaveBeenCalledWith("blob:first");
  controller.schedule("other.tex", "four");
  controller.reset();
  await vi.advanceTimersByTimeAsync(700);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("clears a compiled PDF when the TeX source becomes empty", async () => {
  vi.useFakeTimers();
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ready");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const fetcher = vi.fn().mockResolvedValue(new Response("%PDF", { headers: { "x-source-hash": await sourceHash("content") } }));
  const show = vi.fn();
  const controller = new LatexPreview(show, fetcher);
  controller.schedule("main.tex", "content");
  await vi.advanceTimersByTimeAsync(700);
  await vi.waitFor(() => expect(show).toHaveBeenLastCalledWith({ status: "ready", url: "blob:ready" }));
  controller.clear();
  expect(revoke).toHaveBeenCalledWith("blob:ready");
  expect(show).toHaveBeenLastCalledWith({ status: "waiting" });
  expect(create).toHaveBeenCalledTimes(1);
});

it("hashes sources without crypto.subtle (plain-HTTP non-loopback hosts)", async () => {
  const expected = await sourceHash("abc");
  expect(expected).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle") ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), "subtle")!;
  Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });
  try { expect(await sourceHash("abc")).toBe(expected); }
  finally { Object.defineProperty(globalThis.crypto, "subtle", subtle); }
});

it("keeps waiting while the single compile slot is busy for longer than eight quick retries", async () => {
  vi.useFakeTimers();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const hash = await sourceHash("busy");
  let calls = 0;
  const fetcher = vi.fn().mockImplementation(async () => (++calls <= 12 ? new Response("busy", { status: 429 }) : new Response("%PDF", { headers: { "x-source-hash": hash } })));
  const show = vi.fn();
  const controller = new LatexPreview(show, fetcher);
  controller.schedule("main.tex", "busy");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(13);
  expect(show).toHaveBeenLastCalledWith({ status: "ready", url: "blob:late" });
  expect(show).not.toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  controller.reset();
});

it("surfaces compiler errors as text and retries deduplicated older revisions", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("%PDF-old", { headers: { "x-source-hash": "older" } })).mockResolvedValueOnce(new Response(JSON.stringify({ error: "<script>bad</script>", log: "line 3" }), { status: 422 }));
  const show = vi.fn();
  const controller = new LatexPreview(show, fetcher);
  controller.schedule("main.tex", "new");
  await vi.advanceTimersByTimeAsync(1500);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(show).toHaveBeenLastCalledWith({ status: "error", error: "<script>bad</script>\nline 3" }));
  controller.reset();
});
