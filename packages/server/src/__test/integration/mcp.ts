/**
 * Calls one MCP tool over HTTP and hands back the parsed JSON of its text
 * result. The transport is stateless, so no `initialize` has to come first, and
 * it answers as a one-event stream.
 */
export const callMcpTool = async (
  url: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; result?: unknown; isError?: boolean }> => {
  const response = await Bun.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id: 1,
    }),
  });

  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status };
  }

  const event = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  if (!event) throw new Error("MCP answered without a data event");

  const message = JSON.parse(event.slice("data: ".length)) as {
    result?: { content: { type: string; text: string }[]; isError?: boolean };
    error?: { code: number; message: string };
  };
  if (message.error) {
    throw new Error(
      `MCP answered with JSON-RPC error ${message.error.code}: ${message.error.message}`,
    );
  }
  if (!message.result) throw new Error(`MCP answered with neither a result nor an error: ${event}`);
  const text = message.result.content[0]?.text ?? "";

  let result: unknown = text;
  try {
    result = JSON.parse(text);
  } catch {
    // An error result is plain text.
  }

  return { status: 200, result, isError: message.result.isError };
};
