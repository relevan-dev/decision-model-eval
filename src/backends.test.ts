import { afterEach, describe, expect, it, vi } from "vitest";

import { isBackend, modelFromEnv } from "./backends";

describe(modelFromEnv, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names the missing variable for each backend", () => {
    vi.stubEnv("LAYA_BASE_URL", "");
    vi.stubEnv("JEV_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => modelFromEnv("laya")).toThrow(/LAYA_BASE_URL/);
    expect(() => modelFromEnv("jev")).toThrow(/JEV_API_KEY/);
    expect(() => modelFromEnv("claude")).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("sends Jev a model name, because the hosted API requires one", async () => {
    vi.stubEnv("JEV_API_KEY", "secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answers: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await modelFromEnv("jev")({ state: {}, questions: {} });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "jev-latest" });
    vi.restoreAllMocks();
  });
});

describe(isBackend, () => {
  it("accepts only the known backends", () => {
    expect(isBackend("jev")).toBeTruthy();
    expect(isBackend("gpt")).toBeFalsy();
  });
});
