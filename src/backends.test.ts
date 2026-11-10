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

  it("sends CLM to a local clm-serve with the reference model by default", async () => {
    vi.stubEnv("CLM_BASE_URL", "");
    vi.stubEnv("CLM_MODEL", "");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answers: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await modelFromEnv("clm")({ state: {}, questions: {} });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe("http://127.0.0.1:8700/v1/systemone");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "clm-latest" });
    vi.restoreAllMocks();
  });
  it("sends Clef to Workers AI with the account and token from the environment", async () => {
    vi.stubEnv("CLEF_BASE_URL", "");
    vi.stubEnv("CLEF_MODEL", "clef-flash");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { answers: {} }, success: true, errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await modelFromEnv("clef")({ state: {}, questions: {} });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-flash",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "clef-flash" });
    vi.restoreAllMocks();
  });

  it("needs Cloudflare credentials for Clef unless CLEF_BASE_URL is set", () => {
    vi.stubEnv("CLEF_BASE_URL", "");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    expect(() => modelFromEnv("clef")).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    vi.stubEnv("CLEF_BASE_URL", "http://127.0.0.1:8000");
    expect(() => modelFromEnv("clef")).not.toThrow();
  });
});

describe("nemotron backends", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["nemotron-nano", "http://127.0.0.1:8900/v1/chat/completions", "nemotron-nano"],
    ["nemotron-lightning", "http://127.0.0.1:8901/v1/chat/completions", "nemotron-lightning"],
  ] as const)("sends %s to its local vLLM server by default", async (backend, href, model) => {
    vi.stubEnv("NEMOTRON_NANO_BASE_URL", "");
    vi.stubEnv("NEMOTRON_LIGHTNING_BASE_URL", "");
    vi.stubEnv("NEMOTRON_NANO_MODEL", "");
    vi.stubEnv("NEMOTRON_LIGHTNING_MODEL", "");
    vi.stubEnv("NEMOTRON_THINKING", "");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await modelFromEnv(backend)({ state: {}, questions: {} });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(href);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model,
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});

describe(isBackend, () => {
  it("accepts only the known backends", () => {
    expect(isBackend("jev")).toBeTruthy();
    expect(isBackend("gpt")).toBeFalsy();
  });
});
