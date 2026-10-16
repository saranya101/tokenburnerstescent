import { expect, it, vi } from "vitest";
import { GET } from "./route";
it("retires provider callbacks without making any provider calls", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect((await GET()).status).toBe(410);
  expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
});
