import http from "node:http";

/**
 * The heading OpenCode's compaction prompt requires in the reply. A real
 * summary must use the requested template; the fixture returns one so a
 * compaction completes in a single request instead of triggering the nudge
 * retry.
 */
const COMPACTION_PROMPT = "You MUST summarize the conversation above";
const COMPACTION_REPLY = [
  "## Objective",
  "fixture compaction summary",
  "## Work State",
  "### Completed",
  "fixture request summarized",
  "### Active",
  "none",
  "### Blocked",
  "none",
  "## Next Move",
  "none",
  "## Relevant Files",
  "none",
  "## Important Context",
  "fixture provider",
].join("\n");

/**
 * Minimal OpenAI-compatible fixture provider. It records every completion
 * request and never contacts a paid endpoint. The reply echoes the last user
 * message so tests can attribute a provider request to the session that sent
 * it. Compaction prompts get a template-shaped summary so they settle without
 * a second request.
 */
export function createFixtureProvider() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const lastUser = [...(body.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user");
    const text =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.map((part) => part.text ?? "").join(" ")
          : "";
    requests.push({
      at: Date.now(),
      model: body.model,
      stream: body.stream === true,
      text,
      compaction: text.startsWith(COMPACTION_PROMPT),
      messages: body.messages?.length ?? 0,
    });
    const reply = text.startsWith(COMPACTION_PROMPT)
      ? COMPACTION_REPLY
      : `fixture-reply:${text.slice(0, 80)}`;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const base = {
      id: `chatcmpl-fixture-${requests.length}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "fixture-model",
    };
    response.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`,
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });
  return {
    requests,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Fixture provider did not bind a TCP port.");
      }
      return `http://127.0.0.1:${address.port}/v1`;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
