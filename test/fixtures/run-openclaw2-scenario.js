import plugin from '../../dist/index.js';

const baseUrl = process.argv[2];
const scenario = process.argv[3];

const handlers = new Map();
const api = {
  pluginConfig: {
    publicKey: 'pk-test',
    secretKey: 'sk-test',
    baseUrl,
  },
  config: { meta: { lastTouchedVersion: '2026.10.2' } },
  runtime: { version: '2026.10.2' },
  logger: {
    info: () => {},
    warn: (message) => console.log(message),
    error: (message) => console.error(message),
  },
  on: (name, handler) => handlers.set(name, handler),
};

plugin.register(api);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (scenario === 'control-ui-full') {
  const ctx = {
    agentId: 'main',
    sessionKey: 'agent:main:main',
    sessionId: 'sess-v2-control-ui',
    runId: 'run-v2-1',
    trigger: 'webchat',
  };
  const modelResolveResult = await handlers.get('before_model_resolve')(
    { prompt: 'Check weather in Tokyo' },
    { agentId: 'main', sessionKey: 'agent:main:main', trigger: 'webchat' },
  );
  if (modelResolveResult !== undefined) {
    throw new Error(`before_model_resolve must return undefined, got ${JSON.stringify(modelResolveResult)}`);
  }
  const promptBuildResult = await handlers.get('before_prompt_build')(
    { prompt: 'Check weather in Tokyo', messages: [] },
    ctx,
  );
  if (promptBuildResult !== undefined) {
    throw new Error(`before_prompt_build must return undefined, got ${JSON.stringify(promptBuildResult)}`);
  }
  await handlers.get('llm_input')(
    {
      runId: 'run-v2-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      prompt: 'Check weather in Tokyo',
      historyMessages: [],
    },
    ctx,
  );
  await handlers.get('before_tool_call')(
    { toolName: 'get_weather', toolCallId: 'tc-1', params: { city: 'Tokyo' } },
    ctx,
  );
  await handlers.get('after_tool_call')(
    { toolName: 'get_weather', toolCallId: 'tc-1', result: { tempC: 22 }, durationMs: 42 },
    ctx,
  );
  await handlers.get('llm_output')(
    {
      runId: 'run-v2-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      assistantTexts: ['It is 22C in Tokyo.'],
      usage: { input: 120, output: 18 },
    },
    ctx,
  );
  await handlers.get('agent_end')(
    { success: true, durationMs: 300, messages: [{ role: 'assistant', content: 'It is 22C in Tokyo.' }] },
    ctx,
  );
  await wait(1000);
} else if (scenario === 'llm-input-only') {
  const ctx = {
    agentId: 'coder',
    sessionKey: 'agent:coder:main',
    sessionId: 'sess-v2-llm-only',
    runId: 'run-llm-only-1',
  };
  await handlers.get('llm_input')(
    {
      runId: 'run-llm-only-1',
      provider: 'openai',
      model: 'gpt-5',
      prompt: 'Write hello world',
      historyMessages: [],
    },
    ctx,
  );
  await handlers.get('llm_output')(
    {
      runId: 'run-llm-only-1',
      provider: 'openai',
      model: 'gpt-5',
      assistantTexts: ['console.log("hello world")'],
      usage: { input: 50, output: 10 },
    },
    ctx,
  );
  await handlers.get('agent_end')(
    { success: true, durationMs: 150, messages: [] },
    ctx,
  );
  await wait(1000);
} else if (scenario === 'multi-turn-session-persistence') {
  const key = 'agent:main:main';
  await handlers.get('session_start')(
    { sessionId: 'sess-uuid-turn-1', reason: 'new' },
    { agentId: 'main', sessionKey: key },
  );

  // Turn 1: has only sessionKey in hooks, expects sess-uuid-turn-1 from session_start
  await handlers.get('before_prompt_build')(
    { prompt: 'Turn 1 question' },
    { agentId: 'main', sessionKey: key, runId: 'run-t1' },
  );
  await handlers.get('llm_input')(
    { runId: 'run-t1', provider: 'openai', model: 'gpt-5', prompt: 'Turn 1 question', historyMessages: [] },
    { agentId: 'main', sessionKey: key },
  );
  await handlers.get('llm_output')(
    { runId: 'run-t1', provider: 'openai', model: 'gpt-5', assistantTexts: ['Turn 1 answer'] },
    { agentId: 'main', sessionKey: key },
  );
  await handlers.get('agent_end')(
    { success: true, durationMs: 50, messages: [] },
    { agentId: 'main', sessionKey: key },
  );
  await wait(1000);

  // Turn 2: no session_start, no sessionId in payload — must still carry sess-uuid-turn-1
  await handlers.get('before_prompt_build')(
    { prompt: 'Turn 2 question' },
    { agentId: 'main', sessionKey: key, runId: 'run-t2' },
  );
  await handlers.get('llm_input')(
    { runId: 'run-t2', provider: 'openai', model: 'gpt-5', prompt: 'Turn 2 question', historyMessages: [] },
    { agentId: 'main', sessionKey: key },
  );
  await handlers.get('llm_output')(
    { runId: 'run-t2', provider: 'openai', model: 'gpt-5', assistantTexts: ['Turn 2 answer'] },
    { agentId: 'main', sessionKey: key },
  );
  await handlers.get('agent_end')(
    { success: true, durationMs: 60, messages: [] },
    { agentId: 'main', sessionKey: key },
  );
  await wait(1000);

  // Session rotates via session_end + new session_start
  await handlers.get('session_end')(
    { sessionId: 'sess-uuid-turn-1', reason: 'daily', durationMs: 5000, messageCount: 4 },
    { agentId: 'main', sessionKey: key },
  );
  await handlers.get('session_start')(
    { sessionId: 'sess-uuid-turn-3', reason: 'daily' },
    { agentId: 'main', sessionKey: key },
  );

  // Turn 3: must carry the new sess-uuid-turn-3
  await handlers.get('before_prompt_build')(
    { prompt: 'Turn 3 question' },
    { agentId: 'main', sessionKey: key, runId: 'run-t3' },
  );
  await handlers.get('llm_input')(
    { runId: 'run-t3', provider: 'openai', model: 'gpt-5', prompt: 'Turn 3 question', historyMessages: [] },
    { agentId: 'main', sessionKey: key },
  );
  await handlers.get('llm_output')(
    { runId: 'run-t3', provider: 'openai', model: 'gpt-5', assistantTexts: ['Turn 3 answer'] },
    { agentId: 'main', sessionKey: key },
  );
  await handlers.get('agent_end')(
    { success: true, durationMs: 70, messages: [] },
    { agentId: 'main', sessionKey: key },
  );
  await wait(1000);
} else if (scenario === 'session-key-fallback') {
  const ctx = { agentId: 'main', sessionKey: 'agent:main:discord:dm:42' };
  await handlers.get('llm_input')(
    { runId: 'run-key-only', provider: 'openai', model: 'gpt-5', prompt: 'Hi', historyMessages: [] },
    ctx,
  );
  await handlers.get('llm_output')(
    { runId: 'run-key-only', provider: 'openai', model: 'gpt-5', assistantTexts: ['Hello!'] },
    ctx,
  );
  await handlers.get('agent_end')({ success: true, durationMs: 40, messages: [] }, ctx);
  await wait(1000);
} else if (scenario === 'channel-message-and-parallel-tools') {
  await handlers.get('message_received')(
    { from: 'telegram-user-1', role: 'user', content: 'Run two checks' },
    { channelId: 'telegram', conversationId: 'chat-99' },
  );
  const agentCtx = {
    agentId: 'main',
    sessionKey: 'agent:main:telegram:dm:99',
    sessionId: 'sess-tg-99',
    runId: 'run-tg-1',
  };
  await handlers.get('before_prompt_build')({ prompt: 'Run two checks' }, agentCtx);
  await handlers.get('llm_input')(
    { runId: 'run-tg-1', provider: 'anthropic', model: 'claude-sonnet-4-6', prompt: 'Run two checks', historyMessages: [] },
    agentCtx,
  );
  await handlers.get('before_tool_call')(
    { toolName: 'check_a', toolCallId: 'call-a', params: { target: 'a' } },
    agentCtx,
  );
  await handlers.get('before_tool_call')(
    { toolName: 'check_b', toolCallId: 'call-b', params: { target: 'b' } },
    agentCtx,
  );
  await handlers.get('after_tool_call')(
    { toolName: 'check_b', toolCallId: 'call-b', result: 'ok-b', durationMs: 12 },
    agentCtx,
  );
  await handlers.get('after_tool_call')(
    { toolName: 'check_a', toolCallId: 'call-a', result: 'ok-a', durationMs: 25 },
    agentCtx,
  );
  await handlers.get('llm_output')(
    { runId: 'run-tg-1', provider: 'anthropic', model: 'claude-sonnet-4-6', assistantTexts: ['Both ok'] },
    agentCtx,
  );
  await handlers.get('agent_end')({ success: true, durationMs: 120, messages: [] }, agentCtx);
  await wait(1000);
} else if (scenario === 'cross-session-isolation') {
  // Session B (a cron run) owns its own turn context before session A starts.
  const cronCtx = {
    agentId: 'main',
    sessionKey: 'agent:main:cron:job-1',
    sessionId: 'sess-cron-b',
    runId: 'run-cron-b',
    trigger: 'cron',
  };
  await handlers.get('before_prompt_build')({ prompt: 'Nightly report' }, cronCtx);
  await handlers.get('llm_input')(
    { runId: 'run-cron-b', sessionId: 'sess-cron-b', provider: 'openai', model: 'gpt-5', prompt: 'Nightly report', historyMessages: [] },
    cronCtx,
  );

  // Session A: a channel message without sessionKey makes A the last user turn.
  const chatCtx = {
    agentId: 'main',
    sessionKey: 'agent:main:telegram:dm:7',
    sessionId: 'sess-chat-a',
    runId: 'run-chat-a',
  };
  await handlers.get('message_received')(
    { from: 'telegram-user-7', role: 'user', content: 'Question from chat A' },
    { channelId: 'telegram', conversationId: 'chat-7' },
  );
  await handlers.get('before_prompt_build')({ prompt: 'Question from chat A' }, chatCtx);
  await handlers.get('llm_input')(
    { runId: 'run-chat-a', sessionId: 'sess-chat-a', provider: 'openai', model: 'gpt-5', prompt: 'Question from chat A', historyMessages: [] },
    chatCtx,
  );
  await handlers.get('llm_output')(
    { runId: 'run-chat-a', provider: 'openai', model: 'gpt-5', assistantTexts: ['Answer for chat A'] },
    chatCtx,
  );
  await handlers.get('agent_end')({ success: true, durationMs: 30, messages: [] }, chatCtx);

  // Session B's hooks land inside A's deferred finalize window.
  await handlers.get('llm_output')(
    { runId: 'run-cron-b', provider: 'openai', model: 'gpt-5', assistantTexts: ['Nightly report done'] },
    cronCtx,
  );
  await handlers.get('agent_end')({ success: true, durationMs: 40, messages: [] }, cronCtx);
  await wait(1000);
} else if (scenario === 'lifecycle-event-attributes') {
  await handlers.get('gateway_start')({ port: 18789 });

  const mainCtx = { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'sess-life-1' };
  await handlers.get('session_start')({ sessionId: 'sess-life-1' }, mainCtx);

  // A session_start that fires while a turn is open is nested under its agent span.
  const turnCtx = { agentId: 'main', sessionKey: 'agent:main:other', sessionId: 'sess-life-2', runId: 'run-life-2' };
  await handlers.get('before_prompt_build')({ prompt: 'Hello' }, turnCtx);
  await handlers.get('session_start')(
    { sessionId: 'sess-life-2', resumedFrom: 'sess-life-0' },
    { agentId: 'main', sessionKey: 'agent:main:other', sessionId: 'sess-life-2' },
  );
  await handlers.get('agent_end')({ success: true, durationMs: 5, messages: [] }, turnCtx);
  await wait(1000);

  await handlers.get('session_end')(
    { sessionId: 'sess-life-1', reason: 'reset', messageCount: 2, durationMs: 100 },
    mainCtx,
  );
  await wait(1000);
} else {
  throw new Error(`Unknown scenario: ${scenario}`);
}

await handlers.get('gateway_stop')();
console.log('scenario completed');
