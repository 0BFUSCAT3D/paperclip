import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { costsApi } from "./costs";

describe("costsApi.quotaWindows", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("adds environmentId to the URL only when set", async () => {
    await costsApi.quotaWindows("company-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/costs/quota-windows");

    await costsApi.quotaWindows("company-1", "environment-1");
    expect(mockApi.get).toHaveBeenLastCalledWith(
      "/companies/company-1/costs/quota-windows?environmentId=environment-1",
    );
  });
});

describe("queryKeys.usageQuotaWindows", () => {
  it("changes when environmentId changes", () => {
    expect(queryKeys.usageQuotaWindows("company-1", "environment-1")).not.toEqual(
      queryKeys.usageQuotaWindows("company-1", "environment-2"),
    );
  });

  it("keeps the current key shape without environmentId", () => {
    expect(queryKeys.usageQuotaWindows("company-1")).toEqual([
      "usage-quota-windows",
      "company-1",
    ]);
  });
});
