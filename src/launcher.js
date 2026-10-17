import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const NOISE_ENVIRONMENT_PREFIX = "DEMO_NOISE_";
const DEFAULT_NOISE_ENVIRONMENT = Object.freeze({
  DEMO_NOISE_PRESET: "none",
  DEMO_NOISE_SEED: "demo-noise-seed",
});

function withoutNoiseEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith(NOISE_ENVIRONMENT_PREFIX)),
  );
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function childSpec(name, entrypoint, port, environment) {
  return {
    name,
    entrypoint: path.join(sourceDirectory, entrypoint),
    environment: {
      ...environment,
      HOST: environment.HOST ?? "127.0.0.1",
      PORT: String(port),
    },
  };
}

export function buildStackSpecs(environment = process.env) {
  const webPort = parsePort(environment.PORT ?? "3000", "PORT");
  const demoEnvironment = {
    ...environment,
    ...DEFAULT_NOISE_ENVIRONMENT,
    DEMO_NOISE_JITTER: environment.DEMO_NOISE_JITTER,
    HOST: "127.0.0.1",
  };
  if (environment.DEMO_NOISE_PRESET !== undefined) {
    demoEnvironment.DEMO_NOISE_PRESET = environment.DEMO_NOISE_PRESET;
  }
  if (environment.DEMO_NOISE_SEED !== undefined) {
    demoEnvironment.DEMO_NOISE_SEED = environment.DEMO_NOISE_SEED;
  }
  if (environment.DEMO_NOISE_JITTER === undefined) {
    delete demoEnvironment.DEMO_NOISE_JITTER;
  }
  const webEnvironment = {
    ...withoutNoiseEnvironment(environment),
    DEMO_FIXED_HOST: "127.0.0.1",
    DEMO_FIXED_PORT: "3002",
    DEMO_VULNERABLE_HOST: "127.0.0.1",
    DEMO_VULNERABLE_PORT: "3001",
    HOST: environment.HOST ?? "0.0.0.0",
  };
  const specs = [
    childSpec("vulnerable", "demos/stub.js", 3001, {
      ...demoEnvironment,
      SERVICE_NAME: "vulnerable",
    }),
    childSpec("fixed", "demos/stub.js", 3002, {
      ...demoEnvironment,
      SERVICE_NAME: "fixed",
    }),
    childSpec("web", "server/index.js", webPort, {
      ...webEnvironment,
    }),
  ];
  return specs;
}

export function startStack({
  environment = process.env,
  spawnProcess = spawn,
  stdio = "inherit",
} = {}) {
  const specs = buildStackSpecs(environment);
  const children = [];
  let shuttingDown = false;
  let exitCode = 0;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const resolveIfFinished = () => {
    if (shuttingDown && children.every((entry) => entry.finished)) {
      resolveDone(exitCode);
    }
  };

  const shutdown = (code = 0) => {
    exitCode = Math.max(exitCode, code);
    if (!shuttingDown) {
      shuttingDown = true;
      for (const entry of children) {
        if (!entry.finished) {
          entry.child.kill("SIGTERM");
        }
      }
    }
    resolveIfFinished();
  };

  for (const spec of specs) {
    let child;
    try {
      child = spawnProcess(process.execPath, [spec.entrypoint], {
        env: spec.environment,
        stdio,
      });
    } catch (error) {
      console.error(`Failed to start ${spec.name} process`, error);
      shutdown(1);
      break;
    }

    const entry = { child, finished: false, name: spec.name };
    children.push(entry);
    child.once("error", (error) => {
      if (!shuttingDown) {
        console.error(`${spec.name} process failed`, error);
        shutdown(1);
      }
    });
    child.once("exit", (code, signal) => {
      entry.finished = true;
      if (!shuttingDown) {
        const reason = signal === null ? `exit code ${code}` : `signal ${signal}`;
        console.error(`${spec.name} process stopped with ${reason}`);
        shutdown(1);
      }
      resolveIfFinished();
    });
  }

  if (children.length !== specs.length && !shuttingDown) {
    shutdown(1);
  }

  return { children: children.map((entry) => entry.child), done, shutdown };
}

function isDirectRun() {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const stack = startStack();
  const forwardSignal = () => stack.shutdown(0);
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  stack.done.then((code) => {
    process.exitCode = code;
  });
}
