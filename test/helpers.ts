import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Mock {
  url: string;
  requests: { auth: string | undefined; body: any }[];
  /** Next responses; each is [status, body]. Falls back to a canned success. */
  queue: [number, unknown][];
  close(): Promise<void>;
}

export const OK_BODY = {
  model: "jev-1.13.0",
  answers: {
    is_urgent: { type: "noul", noul: 0.95 },
    department: { type: "choice", choice: "billing", probabilities: { billing: 0.88, technical: 0.12, sales: 0 }, confidence: 0.81 },
    frustration: { type: "score", score: 1.05, legend: { 0: "Calm", 1: "Frustrated", 2: "Very angry" }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.92 },
  },
  usage: { input_tokens: 296, output_tokens: 20 },
};

export async function startMock(): Promise<Mock> {
  const mock: Mock = { url: "", requests: [], queue: [], close: async () => {} };
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    mock.requests.push({ auth: req.headers.authorization, body });
    const next = mock.queue.shift();
    if (next) {
      res.writeHead(next[0], { "content-type": "application/json" }).end(JSON.stringify(next[1]));
      return;
    }
    // Echo answers for exactly the questions asked, so merged/batched ids round-trip.
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(body.questions ?? {})) {
      answers[id] = q.type === "noul" ? { type: "noul", noul: 0.9 }
        : q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria)[0], probabilities: { [Object.keys(q.criteria)[0]]: 1 }, confidence: 0.8 }
        : { type: "score", score: 1, legend: {}, probabilities: { 0: 0, 1: 1 }, confidence: 0.7 };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "jev-test", answers, usage: OK_BODY.usage }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  mock.url = `http://127.0.0.1:${port}`;
  mock.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return mock;
}

/** Isolated env: temp state/config dirs, mock endpoint, no retries. */
export function testEnv(mock: Mock, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "jev-kit-test-"));
  return {
    PATH: process.env.PATH,
    HOME: dir,
    XDG_STATE_HOME: join(dir, "state"),
    XDG_CONFIG_HOME: join(dir, "config"),
    TYPESAFE_BASE_URL: mock.url,
    TYPESAFE_API_KEY: "test-key",
    ...extra,
  };
}
