const mode = process.argv[2] ?? 'protocol';

process.stderr.write('fake MCP diagnostic\n');

if (mode === 'echo') {
  process.stdin.pipe(process.stdout);
} else {
  let pending = Buffer.alloc(0);

  process.stdin.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    drainLines();
  });

  process.stdin.on('end', () => {
    if (pending.length > 0) handleLine(pending.toString());
  });

  function drainLines() {
    let newline;
    while ((newline = pending.indexOf(0x0a)) !== -1) {
      const line = pending.subarray(0, newline).toString();
      pending = pending.subarray(newline + 1);
      handleLine(line);
    }
  }

  function response(message) {
    if (message?.method !== 'tools/call' || message.id === undefined) return undefined;
    const name = message.params?.name;
    if (name === 'crash') {
      process.stderr.write('fake MCP crash\n', () => process.exit(7));
      return undefined;
    }
    if (name === 'error') {
      return { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'fake failure' } };
    }
    if (name === 'context') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { cwd: process.cwd(), env: process.env.FAKE_PROXY_ENV ?? null },
      };
    }
    return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } };
  }

  function handleLine(line) {
    if (line.trim() === '') return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const values = Array.isArray(parsed) ? parsed : [parsed];
    const responses = values.map(response).filter(Boolean);
    if (responses.length === 0) return;
    const payload = Array.isArray(parsed) ? responses : responses[0];
    const name = values[0]?.params?.name;
    const text = JSON.stringify(payload);
    if (name === 'partial') {
      process.stdout.write(text);
    } else if (name === 'odd') {
      process.stdout.write(` \t${text}  \r\n`);
    } else {
      process.stdout.write(`${text}\n`);
    }
  }
}
