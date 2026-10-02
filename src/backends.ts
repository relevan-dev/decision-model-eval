import { claudeModel, DEFAULT_CLAUDE_MODEL } from "./claude";
import { type DecisionModel, systemOneModel } from "./system-one";

// Builds a decision model from a backend name and the environment. Each backend
// names the variables it needs, so a missing key fails before the first call.

export const BACKENDS = ["laya", "jev", "claude", "clm", "clef"] as const;

export type Backend = (typeof BACKENDS)[number];

export function isBackend(value: string): value is Backend {
  return (BACKENDS as readonly string[]).includes(value);
}

const JEV_BASE_URL = "https://api.typesafe.ai";
/** Jev requires a model name. `jev-latest` resolves to the current version. */
const JEV_DEFAULT_MODEL = "jev-latest";

/** `clm-serve` binds port 8700 by default. */
const CLM_BASE_URL = "http://127.0.0.1:8700";
/** The reference CLM-v0.1-8B head. */
const CLM_DEFAULT_MODEL = "clm-latest";

/** Clef runs on Workers AI unless `CLEF_BASE_URL` names a System One server. */
const CLOUDFLARE_API_URL = "https://api.cloudflare.com";
/** The 27B model. `clef-flash` is the smaller, faster variant. */
const CLEF_DEFAULT_MODEL = "clef";

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. ${hint}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

/** A short name for the report, such as `jev (jev-latest)`. */
export function backendLabel(backend: Backend): string {
  switch (backend) {
    case "laya": {
      return `laya (${optional("LAYA_MODEL") ?? "routed by language"})`;
    }
    case "jev": {
      return `jev (${optional("JEV_MODEL") ?? JEV_DEFAULT_MODEL})`;
    }
    case "claude": {
      return `claude (${optional("CLAUDE_MODEL") ?? DEFAULT_CLAUDE_MODEL})`;
    }
    case "clm": {
      return `clm (${optional("CLM_MODEL") ?? CLM_DEFAULT_MODEL})`;
    }
    case "clef": {
      return `clef (${optional("CLEF_MODEL") ?? CLEF_DEFAULT_MODEL})`;
    }
  }
}

export function modelFromEnv(backend: Backend): DecisionModel {
  switch (backend) {
    case "laya": {
      return systemOneModel({
        baseUrl: required(
          "LAYA_BASE_URL",
          "Point it at a System One server, such as http://127.0.0.1:8000 for a local laya-serve.",
        ),
        apiKey: optional("LAYA_API_KEY"),
        model: optional("LAYA_MODEL"),
        // A CPU server takes about a second per call; leave room for a cold start.
        timeoutMs: 120_000,
      });
    }
    case "jev": {
      return systemOneModel({
        baseUrl: optional("JEV_BASE_URL") ?? JEV_BASE_URL,
        apiKey: required("JEV_API_KEY", "Get a key from TypeSafe to use the hosted Jev API."),
        model: optional("JEV_MODEL") ?? JEV_DEFAULT_MODEL,
      });
    }
    case "claude": {
      required("ANTHROPIC_API_KEY", "Get a key from the Claude Console.");
      return claudeModel({ model: optional("CLAUDE_MODEL") });
    }
    case "clm": {
      return systemOneModel({
        baseUrl: optional("CLM_BASE_URL") ?? CLM_BASE_URL,
        apiKey: optional("CLM_API_KEY"),
        model: optional("CLM_MODEL") ?? CLM_DEFAULT_MODEL,
        // The first call waits on the embedding server's cold start.
        timeoutMs: 120_000,
      });
    }
    case "clef": {
      const model = optional("CLEF_MODEL") ?? CLEF_DEFAULT_MODEL;
      const baseUrl = optional("CLEF_BASE_URL");
      if (baseUrl) {
        return systemOneModel({ baseUrl, apiKey: optional("CLEF_API_KEY"), model, timeoutMs: 120_000 });
      }
      const accountId = required(
        "CLOUDFLARE_ACCOUNT_ID",
        "Clef runs on Workers AI. Set CLEF_BASE_URL instead to use a System One server you host.",
      );
      return systemOneModel({
        baseUrl: CLOUDFLARE_API_URL,
        path: `/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`,
        apiKey: required("CLOUDFLARE_API_TOKEN", "Create a token with Workers AI access in the Cloudflare dashboard."),
        model,
      });
    }
  }
}
