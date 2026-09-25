import { claudeModel, DEFAULT_CLAUDE_MODEL } from "./claude";
import { type DecisionModel, systemOneModel } from "./system-one";

// Builds a decision model from a backend name and the environment. Each backend
// names the variables it needs, so a missing key fails before the first call.

export const BACKENDS = ["laya", "jev", "claude"] as const;

export type Backend = (typeof BACKENDS)[number];

export function isBackend(value: string): value is Backend {
  return (BACKENDS as readonly string[]).includes(value);
}

const JEV_BASE_URL = "https://api.typesafe.ai";
/** Jev requires a model name. `jev-latest` resolves to the current version. */
const JEV_DEFAULT_MODEL = "jev-latest";

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
  }
}
