import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/run-openclaw2-scenario.js', import.meta.url));

function decodeAttrValue(val) {
  if (!val) return undefined;
  if ('stringValue' in val) return val.stringValue;
  if ('boolValue' in val) return val.boolValue;
  if ('intValue' in val) return Number(val.intValue);
  if ('doubleValue' in val) return val.doubleValue;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(decodeAttrValue);
  return val;
}

function getAttrs(span) {
  const result = {};
  for (const attr of span.attributes || []) {
    result[attr.key] = decodeAttrValue(attr.value);
  }
  return result;
}

async function runScenario(scenario) {
  const spans = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (body) {
      const payload = JSON.parse(body);
      for (const rs of payload.resourceSpans || []) {
        for (const ss of rs.scopeSpans || []) {
          for (const span of ss.spans || []) {
            spans.push({
              name: span.name,
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId || '',
              attrs: getAttrs(span),
            });
          }
        }
      }
    }
    response.writeHead(200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        fixture,
        `http://127.0.0.1:${address.port}`,
        scenario,
      ]);
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(result.code, 0, `Scenario ${scenario} failed: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /scenario completed/);
    return spans;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('OpenClaw 2.0 Control UI turn builds full root/agent/generation/tool hierarchy with session info', async () => {
  const spans = await runScenario('control-ui-full');

  const root = spans.find((s) => s.name === 'enter_openclaw_system');
  const agent = spans.find((s) => s.name === 'invoke_agent main');
  const gen = spans.find((s) => s.name === 'chat claude-sonnet-4-6');
  const tool = spans.find((s) => s.name === 'execute_tool get_weather');

  assert.ok(root, `Expected root span, got: ${spans.map((s) => s.name).join(', ')}`);
  assert.ok(agent, `Expected agent span, got: ${spans.map((s) => s.name).join(', ')}`);
  assert.ok(gen, `Expected generation span, got: ${spans.map((s) => s.name).join(', ')}`);
  assert.ok(tool, `Expected tool span, got: ${spans.map((s) => s.name).join(', ')}`);

  // Single trace hierarchy
  assert.equal(agent.traceId, root.traceId);
  assert.equal(gen.traceId, root.traceId);
  assert.equal(tool.traceId, root.traceId);
  assert.equal(agent.parentSpanId, root.spanId);
  assert.equal(gen.parentSpanId, agent.spanId);
  assert.equal(tool.parentSpanId, agent.spanId);

  // Session attributes present across root, agent, generation, and tool
  for (const span of [root, agent, gen, tool]) {
    assert.equal(span.attrs['session.id'], 'sess-v2-control-ui', `Missing session.id on ${span.name}`);
    assert.equal(span.attrs['langfuse.session.id'], 'sess-v2-control-ui', `Missing langfuse.session.id on ${span.name}`);
    assert.equal(span.attrs['openclaw.session.id'], 'sess-v2-control-ui', `Missing openclaw.session.id on ${span.name}`);
    assert.equal(span.attrs['openclaw.session.key'], 'agent:main:main', `Missing openclaw.session.key on ${span.name}`);
  }
  assert.equal(root.attrs['langfuse.internal.as_root'], true);
  assert.match(root.attrs['langfuse.trace.name'], /^openclaw-/);
  assert.equal(root.attrs['langfuse.trace.input'], JSON.stringify('Check weather in Tokyo'));
  assert.equal(root.attrs['langfuse.trace.output'], JSON.stringify('It is 22C in Tokyo.'));
});

test('OpenClaw 2.0 llm_input-only turn still creates root/agent spans and session info', async () => {
  const spans = await runScenario('llm-input-only');

  const root = spans.find((s) => s.name === 'enter_openclaw_system');
  const agent = spans.find((s) => s.name === 'invoke_agent coder');
  const gen = spans.find((s) => s.name === 'chat gpt-5');

  assert.ok(root, 'Expected fallback root span');
  assert.ok(agent, 'Expected fallback agent span');
  assert.ok(gen, 'Expected generation span');

  assert.equal(agent.traceId, root.traceId);
  assert.equal(gen.traceId, root.traceId);
  assert.equal(agent.parentSpanId, root.spanId);
  assert.equal(gen.parentSpanId, agent.spanId);
  assert.equal(root.attrs['session.id'], 'sess-v2-llm-only');
  assert.equal(root.attrs['langfuse.session.id'], 'sess-v2-llm-only');
  assert.equal(gen.attrs['session.id'], 'sess-v2-llm-only');
});

test('OpenClaw 2.0 persists sessionId across multiple turns and rotates on session_end/session_start', async () => {
  const spans = await runScenario('multi-turn-session-persistence');

  const roots = spans.filter((s) => s.name === 'enter_openclaw_system');
  assert.equal(roots.length, 3, `Expected 3 root spans, got ${roots.length}`);

  const byInput = new Map(roots.map((r) => [r.attrs['langfuse.trace.input'], r]));
  const turn1 = byInput.get(JSON.stringify('Turn 1 question'));
  const turn2 = byInput.get(JSON.stringify('Turn 2 question'));
  const turn3 = byInput.get(JSON.stringify('Turn 3 question'));

  assert.ok(turn1 && turn2 && turn3, 'Expected all three turns');
  assert.equal(turn1.attrs['session.id'], 'sess-uuid-turn-1');
  assert.equal(turn2.attrs['session.id'], 'sess-uuid-turn-1');
  assert.equal(turn3.attrs['session.id'], 'sess-uuid-turn-3');

  // Ensure session_start did not create ghost traces with session.id set on standalone event
  const sessionStarts = spans.filter((s) => s.name === 'session_start');
  assert.equal(sessionStarts.length, 2);
  for (const s of sessionStarts) {
    assert.equal(s.attrs['session.id'], undefined);
  }
});

test('OpenClaw 2.0 falls back to sessionKey when sessionId is unavailable', async () => {
  const spans = await runScenario('session-key-fallback');

  const root = spans.find((s) => s.name === 'enter_openclaw_system');
  const gen = spans.find((s) => s.name === 'chat gpt-5');
  assert.ok(root && gen);
  assert.equal(root.attrs['session.id'], 'agent:main:discord:dm:42');
  assert.equal(root.attrs['langfuse.session.id'], 'agent:main:discord:dm:42');
  assert.equal(gen.attrs['session.id'], 'agent:main:discord:dm:42');
});

test('A concurrent run in another session does not overwrite the last user turn session', async () => {
  const spans = await runScenario('cross-session-isolation');

  const roots = spans.filter((s) => s.name === 'enter_openclaw_system');
  const chatRoot = roots.find((r) => r.attrs['openclaw.session.key'] === 'agent:main:telegram:dm:7');
  const cronRoot = roots.find((r) => r.attrs['openclaw.session.key'] === 'agent:main:cron:job-1');

  assert.ok(chatRoot && cronRoot, `Expected both roots, got: ${roots.map((r) => r.attrs['openclaw.session.key']).join(', ')}`);
  for (const key of ['session.id', 'langfuse.session.id', 'openclaw.session.id']) {
    assert.equal(chatRoot.attrs[key], 'sess-chat-a', `chat root ${key}`);
    assert.equal(cronRoot.attrs[key], 'sess-cron-b', `cron root ${key}`);
  }
  for (const span of spans.filter((s) => s.traceId === chatRoot.traceId)) {
    if (span.attrs['session.id'] !== undefined) {
      assert.equal(span.attrs['session.id'], 'sess-chat-a', `${span.name} in chat trace`);
    }
  }
});

test('Lifecycle events keep the attributes set on them', async () => {
  const spans = await runScenario('lifecycle-event-attributes');

  const gateway = spans.find((s) => s.name === 'gateway_start');
  assert.ok(gateway, 'Expected gateway_start event');
  assert.equal(gateway.attrs['langfuse.observation.type'], 'event');
  assert.equal(gateway.attrs['langfuse.internal.as_root'], true);
  assert.match(gateway.attrs['langfuse.trace.name'] || '', /^gateway-[0-9a-f]{8}$/);
  assert.deepEqual(gateway.attrs['langfuse.trace.tags'], ['openclaw']);
  assert.equal(gateway.attrs['openclaw.version'], '2026.10.2');

  const starts = spans.filter((s) => s.name === 'session_start');
  const standaloneStart = starts.find((s) => s.attrs['openclaw.session.id'] === 'sess-life-1');
  const nestedStart = starts.find((s) => s.attrs['openclaw.session.id'] === 'sess-life-2');
  assert.ok(standaloneStart && nestedStart, `Expected both session_start events, got ${JSON.stringify(starts.map((s) => s.attrs))}`);
  assert.equal(standaloneStart.attrs['langfuse.observation.type'], 'event');
  assert.equal(standaloneStart.attrs['openclaw.session.key'], 'agent:main:main');
  assert.equal(standaloneStart.attrs['session.id'], undefined);
  assert.equal(nestedStart.attrs['openclaw.session.key'], 'agent:main:other');
  assert.equal(nestedStart.attrs['langfuse.observation.metadata.session.resumed_from'], 'sess-life-0');

  const agent = spans.find((s) => s.name === 'invoke_agent main');
  assert.ok(agent, 'Expected agent span for the open turn');
  assert.equal(nestedStart.traceId, agent.traceId);
  assert.equal(nestedStart.parentSpanId, agent.spanId);

  const end = spans.find((s) => s.name === 'session_end');
  assert.ok(end, 'Expected session_end event');
  assert.equal(end.attrs['langfuse.observation.type'], 'event');
  assert.equal(end.attrs['openclaw.session.id'], 'sess-life-1');
  assert.equal(end.attrs['openclaw.session.key'], 'agent:main:main');
  assert.equal(end.attrs['langfuse.observation.metadata.session.reason'], 'reset');
  assert.equal(end.attrs['langfuse.observation.output'], JSON.stringify({ messageCount: 2, durationMs: 100, reason: 'reset' }));
});

test('Channel message_received links OpenClaw 2.0 sessionId and supports parallel tool calls', async () => {
  const spans = await runScenario('channel-message-and-parallel-tools');

  const root = spans.find((s) => s.name === 'enter_openclaw_system');
  const agent = spans.find((s) => s.name === 'invoke_agent main');
  const toolA = spans.find((s) => s.name === 'execute_tool check_a');
  const toolB = spans.find((s) => s.name === 'execute_tool check_b');

  assert.ok(root && agent && toolA && toolB);
  assert.equal(root.attrs['session.id'], 'sess-tg-99');
  assert.equal(root.attrs['langfuse.session.id'], 'sess-tg-99');
  assert.equal(root.attrs['openclaw.session.key'], 'agent:main:telegram:dm:99');
  assert.equal(agent.parentSpanId, root.spanId);
  assert.equal(toolA.parentSpanId, agent.spanId);
  assert.equal(toolB.parentSpanId, agent.spanId);
  assert.equal(toolA.attrs['gen_ai.tool.call.result'], 'ok-a');
  assert.equal(toolB.attrs['gen_ai.tool.call.result'], 'ok-b');
});
