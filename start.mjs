import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "./game-worker.js";

const database = new DatabaseSync(":memory:");
database.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

const DB = {
  prepare(query) {
    const statement = database.prepare(query);
    return {
      bind(...values) {
        return {
          first: () => statement.get(...values),
          run: () => ({ meta: statement.run(...values) }),
        };
      },
    };
  },
  batch(operations) {
    database.exec("BEGIN");
    try {
      const results = operations.map(operation => operation.run());
      database.exec("COMMIT");
      return results;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
};

createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of incoming) {
      length += chunk.length;
      if (length > 24_000) {
        outgoing.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }

    const publicOrigin = process.env.RENDER_EXTERNAL_URL ||
      "http://" + incoming.headers.host;
    const url = new URL(publicOrigin);
    const incomingUrl = new URL(incoming.url, "http://local");
    url.pathname = incomingUrl.pathname;
    url.search = incomingUrl.search;
    const request = new Request(url, {
      method: incoming.method,
      headers: new Headers(incoming.headers),
      ...(length ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await worker.fetch(request, { DB });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(incoming.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
}).listen(Number(process.env.PORT || 10000), "0.0.0.0");
