/**
 * Cloudflare Worker - Microsoft Edge TTS 服务代理
 *
 * @version 2.5.0
 * @description 在 v2.4 稳定版基础上增加情感标签识别（[sarcastic]、[happy] 等），
 *              支持晓晓原生风格 + styledegree 情感强度调节。
 *              自动识别文本中的 [标签]，映射到对应语音风格并按段合成。
 *
 * @features
 * - 情感标签自动识别（45+ 标签 → 晓晓原生风格）
 * - styledegree 情感强度控制（0.01–2.0）
 * - 支持流式和非流式 TTS 输出
 * - 自动文本清理和分块处理
 * - 智能批处理避免 Cloudflare 限制
 * - 兼容 OpenAI TTS API 格式
 * - 支持多种中英文语音
 */

// =================================================================================
// 配置参数
// =================================================================================

// API 密钥配置
const API_KEY = globalThis.API_KEY;

// 批处理配置
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_CHUNK_SIZE = 300;

// 默认语音（晓晓）
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

// 默认风格
const DEFAULT_STYLE = 'general';

// OpenAI 语音映射到 Microsoft 语音
const OPENAI_VOICE_MAP = {
  alloy: 'zh-CN-YunyangNeural',
  ash: 'zh-CN-YunxiNeural',
  ballad: 'zh-CN-XiaohanNeural',
  cedar: 'zh-CN-XiaoqiuNeural',
  coral: 'zh-CN-XiaoxiaoNeural',
  echo: 'zh-CN-liaoning-XiaobeiNeural',
  fable: 'zh-CN-YunjianNeural',
  marin: 'zh-CN-XiaoyanNeural',
  nova: 'zh-CN-XiaoyiNeural',
  onyx: 'zh-CN-YunzeNeural',
  sage: 'zh-CN-XuanNeural',
  shimmer: 'zh-CN-XiaoruiNeural',
  verse: 'zh-CN-XiaomoNeural'
};

// =================================================================================
// 情感标签映射表（晓晓专属）
// style    = 晓晓原生风格
// degree   = styledegree 情感强度 (0.01–2.0, 默认 1)
// rateMul  = 语速倍数（相对于请求基础 speed）
// pitchMul = 音调倍数（相对于请求基础 pitch）
// ⚠️ 标记 = 晓晓无原生风格，用近似风格 + rate/pitch 模拟
// =================================================================================
const XIAOXIAO_TAG_MAP = {
  // ===== 1. 核心情感 =====
  happy:       { style: 'cheerful',      degree: 1.2 },
  sad:         { style: 'sad',           degree: 1.3, rateMul: 0.92, pitchMul: 0.96 },
  angry:       { style: 'angry',         degree: 1.3, rateMul: 1.05, pitchMul: 1.03 },
  surprised:   { style: 'cheerful',      degree: 1.8, rateMul: 1.10, pitchMul: 1.08 }, // ⚠️
  fear:        { style: 'fearful',       degree: 1.5, rateMul: 1.05 },
  hate:        { style: 'disgruntled',   degree: 1.6, pitchMul: 0.93 },                // ⚠️
  neutral:     { style: 'calm',          degree: 1.0 },
  excited:     { style: 'excited',       degree: 1.5, rateMul: 1.08 },

  // ===== 2. 细腻正向 =====
  gentle:      { style: 'gentle',        degree: 1.2, rateMul: 0.95 },
  shy:         { style: 'affectionate',  degree: 0.8, rateMul: 0.95, pitchMul: 1.05 }, // ⚠️
  coquettish:  { style: 'affectionate',  degree: 1.5, rateMul: 0.92, pitchMul: 1.05 },
  teasing:     { style: 'chat',          degree: 1.2, rateMul: 1.03, pitchMul: 1.02 },
  doting:      { style: 'affectionate',  degree: 1.3, rateMul: 0.90, pitchMul: 0.97 },
  sympathetic: { style: 'gentle',        degree: 1.4, rateMul: 0.93, pitchMul: 0.96 }, // ⚠️
  grateful:    { style: 'friendly',      degree: 1.2 },                                // ⚠️
  expectant:   { style: 'cheerful',      degree: 1.4, rateMul: 0.97, pitchMul: 1.05 }, // ⚠️
  playful:     { style: 'cheerful',      degree: 1.5, rateMul: 1.06, pitchMul: 1.06 }, // ⚠️
  relaxed:     { style: 'calm',          degree: 1.0, rateMul: 0.92 },
  lazy:        { style: 'calm',          degree: 0.7, rateMul: 0.82, pitchMul: 0.93 }, // ⚠️

  // ===== 3. 细腻负面 =====
  wronged:      { style: 'sad',          degree: 1.4, rateMul: 0.90, pitchMul: 1.04 }, // ⚠️
  disappointed: { style: 'sad',          degree: 1.2, rateMul: 0.92, pitchMul: 0.94 }, // ⚠️
  jealous:      { style: 'disgruntled',  degree: 1.3, pitchMul: 0.95 },                // ⚠️
  envious:      { style: 'disgruntled',  degree: 1.1, pitchMul: 0.95 },                // ⚠️
  nervous:      { style: 'fearful',      degree: 1.2, rateMul: 1.08, pitchMul: 1.04 }, // ⚠️
  serious:      { style: 'serious',      degree: 1.3, rateMul: 0.97 },

  // ===== 4. 中性与冲突 =====
  confused:     { style: 'chat',         degree: 1.3, rateMul: 0.95, pitchMul: 1.03 }, // ⚠️
  hesitant:     { style: 'calm',         degree: 0.8, rateMul: 0.88 },                 // ⚠️
  firm:         { style: 'serious',      degree: 1.4, rateMul: 0.97, pitchMul: 0.96 }, // ⚠️
  arrogant:     { style: 'disgruntled',  degree: 1.4, rateMul: 0.95, pitchMul: 0.93 }, // ⚠️
  humble:       { style: 'gentle',       degree: 1.1, rateMul: 0.95, pitchMul: 0.97 }, // ⚠️
  sarcastic:    { style: 'disgruntled',  degree: 1.5, rateMul: 0.95, pitchMul: 0.95 },
  contemptuous: { style: 'disgruntled',  degree: 1.8, rateMul: 0.93, pitchMul: 0.90 }, // ⚠️

  // ===== 5. 极致 / 用户定义 =====
  tender:         { style: 'affectionate', degree: 1.6, rateMul: 0.88, pitchMul: 0.95 },
  'lovey-dovey':  { style: 'affectionate', degree: 1.8, rateMul: 0.90, pitchMul: 1.03 },
  depressed:      { style: 'sad',          degree: 1.6, rateMul: 0.85, pitchMul: 0.90 }, // ⚠️
  guilt:          { style: 'sad',          degree: 1.2, rateMul: 0.90, pitchMul: 0.94 }, // ⚠️
  pain:           { style: 'sad',          degree: 1.8, rateMul: 0.85, pitchMul: 0.92 }, // ⚠️
  coldness:       { style: 'serious',      degree: 1.5, rateMul: 0.92, pitchMul: 0.90 }, // ⚠️
  shout:          { style: 'angry',        degree: 1.8, rateMul: 1.15, pitchMul: 1.08 },
  crazy:          { style: 'cheerful',     degree: 2.0, rateMul: 1.10, pitchMul: 1.12 }, // ⚠️
  whispering:     { style: 'whispering',   degree: 1.3, rateMul: 0.90 },
  breath:         { style: 'whispering',   degree: 1.5, rateMul: 0.80, pitchMul: 0.92 }, // ⚠️
  hum:            { style: 'lyrical',      degree: 1.4, rateMul: 0.88, pitchMul: 1.03 },

  // ===== 兼容旧标签 =====
  disgruntled:   { style: 'disgruntled',  degree: 1.0 },
  cheerful:      { style: 'cheerful',     degree: 1.0 },
  affectionate:  { style: 'affectionate', degree: 1.0 },
  calm:          { style: 'calm',         degree: 1.0 },
  assistant:     { style: 'assistant',    degree: 1.0 },
  chat:          { style: 'chat',         degree: 1.0 },
  poetry:        { style: 'poetry-reading', degree: 1.0, rateMul: 0.9 },
  news:          { style: 'newscast',     degree: 1.0 },
  general:       { style: 'calm',         degree: 1.0 },
  normal:        { style: 'calm',         degree: 1.0 },
};

let htmlContent = null;

// =================================================================================
// 主事件监听器
// =================================================================================

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
  const request = event.request;

  if (request.method === 'OPTIONS') return handleOptions(request);

  const url = new URL(request.url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!htmlContent) htmlContent = getHtmlContent();
    return new Response(htmlContent, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  }

  if (API_KEY) {
    const authHeader = request.headers.get('authorization');
    if (
      !authHeader ||
      !authHeader.startsWith('Bearer ') ||
      authHeader.slice(7) !== API_KEY
    ) {
      return errorResponse('无效的 API 密钥', 401, 'invalid_api_key');
    }
  }

  try {
    if (url.pathname === '/v1/audio/speech')
      return await handleSpeechRequest(request);
    if (url.pathname === '/v1/models') return handleModelsRequest();
  } catch (err) {
    console.error('请求处理器错误:', err);
    return errorResponse(err.message, 500, 'internal_server_error');
  }

  return errorResponse('未找到', 404, 'not_found');
}

// =================================================================================
// 路由处理器
// =================================================================================

function handleOptions(request) {
  const headers = makeCORSHeaders(
    request.headers.get('Access-Control-Request-Headers')
  );
  return new Response(null, { status: 204, headers });
}

async function handleSpeechRequest(request) {
  if (request.method !== 'POST') {
    return errorResponse('不允许的方法', 405, 'method_not_allowed');
  }

  // 安全解析 JSON
  let requestBody;
  try {
    requestBody = await request.json();
  } catch {
    return errorResponse('请求体不是合法 JSON', 400, 'invalid_request_error');
  }

  if (!requestBody.input) {
    return errorResponse("'input' 是必需参数", 400, 'invalid_request_error');
  }

  const {
    model = 'tts-1',
    input,
    voice = null,
    response_format = 'mp3',
    speed = 1.0,
    pitch = 1.0,
    style = DEFAULT_STYLE,
    stream = false,
    concurrency = DEFAULT_CONCURRENCY,
    chunk_size = DEFAULT_CHUNK_SIZE,
    cleaning_options = {}
  } = requestBody;

  const finalCleaningOptions = {
    remove_markdown: true,
    remove_emoji: true,
    remove_urls: true,
    remove_line_breaks: true,
    remove_citation_numbers: true,
    custom_keywords: '',
    ...cleaning_options
  };

  const cleanedInput = cleanText(input, finalCleaningOptions);

  const modelAlias = model.replace(/^tts-1-?/, '') || null;
  const finalVoice =
    OPENAI_VOICE_MAP[voice] ||
    OPENAI_VOICE_MAP[modelAlias] ||
    voice ||
    DEFAULT_VOICE;

  const FORMAT_MAP = {
    mp3: { fmt: 'audio-24khz-48kbitrate-mono-mp3', ct: 'audio/mpeg' },
    opus: { fmt: 'webm-24khz-16bit-mono-opus', ct: 'audio/webm' },
    wav: { fmt: 'riff-24khz-16bit-mono-pcm', ct: 'audio/wav' },
    pcm: { fmt: 'raw-24khz-16bit-mono-pcm', ct: 'audio/pcm' }
  };
  const { fmt: outputFormat, ct: contentType } =
    FORMAT_MAP[response_format] ?? FORMAT_MAP['mp3'];

  // 参数钳制
  const safeConcurrency = Math.min(Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY), 20);
  const safeChunkSize = Math.min(Math.max(50, Number(chunk_size) || DEFAULT_CHUNK_SIZE), 1000);
  const safeSpeed = Math.min(Math.max(0.5, Number(speed) || 1.0), 2.0);
  const safePitch = Math.min(Math.max(0.5, Number(pitch) || 1.0), 1.5);

  // 解析情感标签
  const segments = parseStyledSegments(cleanedInput, style, safeSpeed, safePitch);
  const tasks = buildTasks(segments, safeChunkSize, finalVoice, outputFormat);

  if (tasks.length === 0) {
    return errorResponse('清理后没有可合成的文本', 400, 'invalid_request_error');
  }

  if (stream) {
    return streamVoice(tasks, safeConcurrency, contentType);
  }
  return await getVoice(tasks, safeConcurrency, contentType);
}

function handleModelsRequest() {
  const CREATED_AT = 1706745600;
  const models = [
    { id: 'tts-1', object: 'model', created: CREATED_AT, owned_by: 'openai' },
    {
      id: 'tts-1-hd',
      object: 'model',
      created: CREATED_AT,
      owned_by: 'openai'
    },
    ...Object.keys(OPENAI_VOICE_MAP).map(v => ({
      id: `tts-1-${v}`,
      object: 'model',
      created: CREATED_AT,
      owned_by: 'openai'
    }))
  ];
  return new Response(JSON.stringify({ object: 'list', data: models }), {
    headers: { 'Content-Type': 'application/json', ...makeCORSHeaders() }
  });
}

// =================================================================================
// 情感标签解析与任务构建
// =================================================================================

/**
 * 解析带 [tag] 情感标记的文本为分段列表
 * - 未识别的 [xxx] 会被静默丢弃
 * - 支持 <break> 标签透传
 */
function parseStyledSegments(rawText, baseStyle, baseSpeed, basePitch) {
  const parts = rawText.split(/\[([a-zA-Z][a-zA-Z0-9-]*)\]/g);
  const segments = [];

  if (parts[0] && parts[0].trim()) {
    segments.push({
      text: parts[0],
      style: baseStyle,
      rate: baseSpeed,
      pitch: basePitch,
      degree: 1.0
    });
  }

  let curStyle = baseStyle;
  let curRate = baseSpeed;
  let curPitch = basePitch;
  let curDegree = 1.0;

  for (let i = 1; i < parts.length; i += 2) {
    const tag = (parts[i] || '').toLowerCase();
    const content = parts[i + 1] || '';

    const cfg = XIAOXIAO_TAG_MAP[tag];
    if (cfg) {
      curStyle = cfg.style;
      curRate = baseSpeed * (cfg.rateMul ?? 1);
      curPitch = basePitch * (cfg.pitchMul ?? 1);
      curDegree = cfg.degree ?? 1.0;
    } else {
      console.warn(`未知情感标签，已忽略: [${tag}]`);
    }

    if (content.trim()) {
      segments.push({
        text: content,
        style: curStyle,
        rate: curRate,
        pitch: curPitch,
        degree: curDegree
      });
    }
  }

  if (segments.length === 0 && rawText.trim()) {
    segments.push({
      text: rawText,
      style: baseStyle,
      rate: baseSpeed,
      pitch: basePitch,
      degree: 1.0
    });
  }
  return segments;
}

/**
 * 将分段列表展开为一批 TTS 任务
 * task = { text, voice, rate, pitch, style, degree, outputFormat }
 */
function buildTasks(segments, chunkSize, voice, outputFormat) {
  const tasks = [];
  for (const seg of segments) {
    const chunks = smartChunkText(seg.text, chunkSize);
    const rate = ((seg.rate - 1) * 100).toFixed(0);
    const pitch = ((seg.pitch - 1) * 100).toFixed(0);
    for (const chunk of chunks) {
      tasks.push({
        text: chunk,
        voice,
        rate,
        pitch,
        style: seg.style,
        degree: seg.degree,
        outputFormat
      });
    }
  }
  return tasks;
}

// =================================================================================
// 核心 TTS 逻辑
// =================================================================================

function streamVoice(tasks, concurrency, contentType) {
  const { readable, writable } = new TransformStream();
  pipeTasksToStream(writable.getWriter(), tasks, concurrency)
    .catch(err => console.error('流式 TTS 失败:', err));
  return new Response(readable, {
    headers: { 'Content-Type': contentType, ...makeCORSHeaders() }
  });
}

async function pipeTasksToStream(writer, tasks, concurrency) {
  try {
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const audioBlobs = await Promise.all(batch.map(t => getAudioChunk(t)));
      for (const blob of audioBlobs) {
        const arrayBuffer = await blob.arrayBuffer();
        await writer.write(new Uint8Array(arrayBuffer)); // 尊重背压
      }
    }
  } catch (error) {
    console.error('流式 TTS 失败:', error);
    try { writer.abort(error); } catch (_) {}
    throw error;
  } finally {
    try { writer.close(); } catch (_) {}
  }
}

async function getVoice(tasks, concurrency, contentType) {
  const allAudioBlobs = [];
  try {
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const audioBlobs = await Promise.all(batch.map(t => getAudioChunk(t)));
      allAudioBlobs.push(...audioBlobs);
    }

    const concatenatedAudio = new Blob(allAudioBlobs, { type: contentType });
    return new Response(concatenatedAudio, {
      headers: { 'Content-Type': contentType, ...makeCORSHeaders() }
    });
  } catch (error) {
    console.error('非流式 TTS 失败:', error);
    return errorResponse(error.message, 500, 'tts_generation_error');
  }
}

async function getAudioChunk(task) {
  const { text, voice, rate, pitch, style, degree, outputFormat } = task;
  const endpoint = await getEndpoint();
  const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = getSsml(text, voice, rate, pitch, style, degree);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: endpoint.t,
      'Content-Type': 'application/ssml+xml',
      'User-Agent': 'okhttp/4.5.0',
      'X-Microsoft-OutputFormat': outputFormat
    },
    body: ssml
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Edge TTS API 错误: ${response.status} - ${errorText.slice(0, 200)}`
    );
  }

  return response.blob();
}

// =================================================================================
// 身份验证与辅助函数
// =================================================================================

let tokenInfo = { endpoint: null, token: null, expiredAt: null };
const TOKEN_REFRESH_BEFORE_EXPIRY = 5 * 60;

async function getEndpoint() {
  const now = Date.now() / 1000;

  if (
    tokenInfo.token &&
    tokenInfo.expiredAt &&
    now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY
  ) {
    return tokenInfo.endpoint;
  }

  const endpointUrl =
    'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0';
  const clientId = crypto.randomUUID().replace(/-/g, '');

  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Accept-Language': 'zh-Hans',
        'X-ClientVersion': '4.0.530a 5fe1dc6c',
        'X-UserId': '0f04d16a175c411e',
        'X-HomeGeographicRegion': 'zh-Hans-CN',
        'X-ClientTraceId': clientId,
        'X-MT-Signature': await sign(endpointUrl),
        'User-Agent': 'okhttp/4.5.0',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': '0',
        'Accept-Encoding': 'gzip'
      }
    });

    if (!response.ok) {
      throw new Error(`获取端点失败: ${response.status}`);
    }

    const data = await response.json();

    const jwt = data.t.split('.')[1];
    const decodedJwt = JSON.parse(atob(jwt));

    tokenInfo = {
      endpoint: data,
      token: data.t,
      expiredAt: decodedJwt.exp
    };

    console.log(
      `成功获取新 Token，有效期 ${((decodedJwt.exp - now) / 60).toFixed(1)} 分钟`
    );
    return data;
  } catch (error) {
    console.error('获取端点失败:', error);
    // 过期 Token 兜底
    if (tokenInfo.token) {
      console.log('使用过期的缓存 Token 作为备用');
      return tokenInfo.endpoint;
    }
    throw error;
  }
}

async function sign(urlStr) {
  const url = urlStr.split('://')[1];
  const encodedUrl = encodeURIComponent(url);
  const uuidStr = crypto.randomUUID().replace(/-/g, '');
  const formattedDate =
    new Date().toUTCString().replace(/GMT/, '').trim() + ' GMT';

  const bytesToSign =
    `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();

  const decode = base64ToBytes(
    'oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw=='
  );
  const signData = await hmacSha256(decode, bytesToSign);
  const signBase64 = bytesToBase64(signData);

  return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(data)
  );
  return new Uint8Array(signature);
}

function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes));
}

// =================================================================================
// 通用工具函数
// =================================================================================

function getSsml(text, voiceName, rate, pitch, style, degree = 1.0) {
  // XML 注入防护：白名单校验
  const safeVoice = /^[a-zA-Z0-9-]+$/.test(voiceName) ? voiceName : DEFAULT_VOICE;
  const safeStyle = /^[a-zA-Z-]+$/.test(style) ? style : DEFAULT_STYLE;
  const safeDegree = Math.min(Math.max(0.01, Number(degree) || 1.0), 2.0);

  // 先保护 break 标签
  const breakTagRegex =
    /<break\s+time="[^"]*"\s*\/?>|<break\s*\/?>|<break\s+time='[^']*'\s*\/?>/gi;
  const breakTags = [];
  const processedText = text.replace(breakTagRegex, match => {
    const placeholder = `__BREAK_TAG_${breakTags.length}__`;
    breakTags.push(match);
    return placeholder;
  });

  const sanitizedText = processedText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  let finalText = sanitizedText;
  breakTags.forEach((tag, index) => {
    finalText = finalText.replace(`__BREAK_TAG_${index}__`, tag);
  });

  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN">
    <voice name="${safeVoice}">
      <mstts:express-as style="${safeStyle}" styledegree="${safeDegree}">
        <prosody rate="${rate}%" pitch="${pitch}%">${finalText}</prosody>
      </mstts:express-as>
    </voice>
  </speak>`;
}

function smartChunkText(text, maxChunkLength) {
  if (!text) return [];

  const chunks = [];
  let currentChunk = '';

  const sentences = text.split(/([.?!,;:\n。？！，；：\r]+)/g);

  for (const part of sentences) {
    if (currentChunk.length + part.length <= maxChunkLength) {
      currentChunk += part;
    } else {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      // 单段本身超长时，硬切
      if (part.length > maxChunkLength) {
        for (let j = 0; j < part.length; j += maxChunkLength) {
          const sub = part.substring(j, j + maxChunkLength);
          if (sub.length === maxChunkLength) chunks.push(sub);
          else currentChunk = sub;
        }
      } else {
        currentChunk = part;
      }
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(chunk => chunk.length > 0);
}

function cleanText(text, options) {
  let cleanedText = text;

  if (options.remove_urls) {
    cleanedText = cleanedText.replace(/(https?:\/\/[^\s]+)/g, '');
  }

  if (options.remove_markdown) {
    cleanedText = cleanedText.replace(/!\[.*?\]\(.*?\)/g, '');
    // 注意：不动 [tag] 形式的纯方括号，避免误删情感标签
    cleanedText = cleanedText.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    cleanedText = cleanedText.replace(/(\*\*|__)(.*?)\1/g, '$2');
    cleanedText = cleanedText.replace(/(\*|_)(.*?)\1/g, '$2');
    cleanedText = cleanedText.replace(/`{1,3}(.*?)`{1,3}/g, '$1');
    cleanedText = cleanedText.replace(/#{1,6}\s/g, '');
  }

  if (options.custom_keywords) {
    const keywords = options.custom_keywords
      .split(',')
      .map(k => k.trim())
      .filter(k => k);

    if (keywords.length > 0) {
      const escapedKeywords = keywords.map(k =>
        k.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
      );
      const regex = new RegExp(escapedKeywords.join('|'), 'g');
      cleanedText = cleanedText.replace(regex, '');
    }
  }

  if (options.remove_emoji) {
    cleanedText = cleanedText.replace(/\p{Emoji_Presentation}/gu, '');
  }

  if (options.remove_citation_numbers) {
    cleanedText = cleanedText.replace(/\s\d{1,2}(?=[.。，,;；:：]|$)/g, '');
  }

  if (options.remove_line_breaks) {
    cleanedText = cleanedText.replace(/\s+/g, ' ');
  }

  return cleanedText.trim();
}

function errorResponse(message, status, code, type = 'api_error') {
  return new Response(
    JSON.stringify({
      error: { message, type, param: null, code }
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json', ...makeCORSHeaders() }
    }
  );
}

function makeCORSHeaders(extraHeaders = 'Content-Type, Authorization') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': extraHeaders,
    'Access-Control-Max-Age': '86400'
  };
}

/**
 * 获取 HTML 内容
 */
function getHtmlContent() {
  return `<!DOCTYPE html>
<html lang="zh-Hans">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
  <title>🎙️ TTS 语音合成</title>
  <link rel="preconnect" href="https://fonts.loli.net" crossorigin />
  <link href="https://fonts.loli.net/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #f5ede0;
      --bg-gradient: linear-gradient(160deg, #fdefd8 0%, #f8e8d8 45%, #f0e8f5 100%);
      --surface: #ffffff;
      --surface-hover: #fdf8f3;
      --surface-inset: #faf5ee;
      --header-bg: linear-gradient(160deg, #fff8f0 0%, #ffffff 100%);
      --primary: #c25c18;
      --primary-light: #fdf0e6;
      --primary-shadow: rgba(194, 92, 24, 0.18);
      --success: #2d9e6b;
      --success-light: #edfaf3;
      --error: #c84040;
      --error-light: #fdf0f0;
      --info: #3b7dd8;
      --info-light: #edf4ff;
      --warning: #b96b1a;
      --warning-light: #fff8ed;
      --text: #1c1917;
      --text-muted: #78716c;
      --text-subtle: #a8a29e;
      --border: #e8dfd4;
      --border-focus: #e8620c;
      --shadow-sm: 0 1px 3px rgba(180,100,40,.08), 0 1px 2px rgba(0,0,0,.04);
      --shadow-md: 0 4px 12px rgba(180,100,40,.10), 0 2px 4px rgba(0,0,0,.05);
      --shadow-lg: 0 20px 50px rgba(180,100,40,.13), 0 6px 16px rgba(0,0,0,.06);
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 20px;
      --radius-xl: 24px;
      --font: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--bg-gradient); background-attachment: fixed; min-height: 100vh; color: var(--text); line-height: 1.6; font-size: 15px; }
    [v-cloak] { display: none; }
    .app-container { display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; padding: 2.5rem 1rem 3rem; }
    .container { max-width: 820px; width: 100%; background: var(--surface); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); border: 1px solid var(--border); overflow: hidden; }
    .page-header { padding: 2.2rem 2.5rem 1.8rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 1rem; background: var(--header-bg); }
    .header-icon { width: 44px; height: 44px; background: var(--primary-light); border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--primary); }
    .header-text h1 { margin: 0; font-size: 1.35rem; font-weight: 700; color: var(--text); line-height: 1.3; }
    .header-text p { margin: 0.2rem 0 0; font-size: 0.82rem; color: var(--text-muted); }
    .page-body { padding: 2rem 2.5rem 2.5rem; }
    .section-card { border: 1px solid var(--border); border-radius: var(--radius-md); margin-bottom: 1.5rem; background: var(--surface); overflow: hidden; }
    .section-card summary { display: flex; align-items: center; gap: 0.6rem; padding: 0.9rem 1.1rem; font-weight: 600; font-size: 0.88rem; color: var(--text-muted); cursor: pointer; list-style: none; user-select: none; transition: background 0.15s, color 0.15s; letter-spacing: 0.02em; text-transform: uppercase; }
    .section-card summary::-webkit-details-marker { display: none; }
    .section-card summary:hover { background: var(--surface-hover); color: var(--text); }
    .section-card[open] summary { color: var(--primary); border-bottom: 1px solid var(--border); }
    .section-card summary .chevron { margin-left: auto; width: 16px; height: 16px; color: var(--text-subtle); transition: transform 0.2s; }
    .section-card[open] summary .chevron { transform: rotate(180deg); }
    .section-body { padding: 1.2rem 1.1rem; background: var(--surface-inset); }
    .form-group { margin-bottom: 1.25rem; }
    .form-group:last-child { margin-bottom: 0; }
    label { display: block; font-weight: 600; font-size: 0.85rem; margin-bottom: 0.45rem; color: var(--text); letter-spacing: 0.01em; }
    input[type="text"], input[type="password"], input[type="number"], select, textarea { width: 100%; padding: 0.7rem 0.9rem; border: 1.5px solid var(--border); border-radius: var(--radius-sm); font-size: 0.95rem; font-family: var(--font); background: var(--surface); color: var(--text); transition: border-color 0.18s, box-shadow 0.18s; -webkit-appearance: none; appearance: none; }
    input[type="text"]:focus, input[type="password"]:focus, input[type="number"]:focus, select:focus, textarea:focus { outline: none; border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--primary-shadow); }
    input::placeholder, textarea::placeholder { color: var(--text-subtle); }
    textarea { resize: vertical; min-height: 164px; line-height: 1.65; }
    select { cursor: pointer; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%2378716c' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 0.8rem center; padding-right: 2.2rem; }
    .label-with-controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.45rem; }
    .pause-controls { display: flex; align-items: center; gap: 0.5rem; }
    .pause-input { width: 7em; padding: 0.35rem 0.6rem; border: 1.5px solid var(--border); border-radius: 6px; font-size: 0.85rem; text-align: center; font-family: var(--font); background: var(--surface); color: var(--text); }
    .pause-input:focus { outline: none; border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--primary-shadow); }
    .btn-insert-pause { background: var(--primary-light); color: var(--primary); padding: 0.35rem 0.75rem; border: 1.5px solid transparent; border-radius: 6px; font-size: 0.82rem; font-weight: 600; font-family: var(--font); cursor: pointer; transition: all 0.15s; white-space: nowrap; }
    .btn-insert-pause:hover { background: var(--primary); color: #fff; }
    .btn-insert-pause:active { transform: scale(0.96); }
    .textarea-footer { margin-top: 0.5rem; display: flex; justify-content: space-between; align-items: center; gap: 1.25rem; }
    .char-counter { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; }
    .char-count-text { font-size: 0.8rem; color: var(--text-subtle); }
    .char-count-text.warn { color: var(--warning); }
    .char-count-text.danger { color: var(--error); }
    .char-bar { height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; }
    .char-bar-fill { height: 100%; border-radius: 2px; background: var(--primary); transition: width 0.2s, background 0.2s; }
    .char-bar-fill.warn { background: var(--warning); }
    .char-bar-fill.danger { background: var(--error); }
    .clear-btn { background: none; border: none; color: var(--text-subtle); font-size: 0.8rem; font-family: var(--font); cursor: pointer; padding: 0.2rem 0.5rem; border-radius: 4px; transition: color 0.15s, background 0.15s; flex-shrink: 0; }
    .clear-btn:hover { background: var(--error-light); color: var(--error); }
    .grid-layout { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 1.25rem; }
    .slider-group { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.2rem; }
    .slider-group input[type="range"] { flex: 1; height: 4px; border-radius: 2px; background: var(--border); outline: none; -webkit-appearance: none; appearance: none; cursor: pointer; }
    .slider-group input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: var(--primary); cursor: pointer; box-shadow: 0 1px 4px var(--primary-shadow); transition: transform 0.15s; }
    .slider-group input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.15); }
    .slider-group input[type="range"]::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: var(--primary); cursor: pointer; border: none; box-shadow: 0 1px 4px var(--primary-shadow); }
    .slider-value { font-weight: 600; min-width: 46px; text-align: right; color: var(--primary); font-size: 0.88rem; font-variant-numeric: tabular-nums; }
    .checkbox-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap: 0.6rem; }
    .checkbox-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.65rem; border-radius: var(--radius-sm); border: 1.5px solid var(--border); background: var(--surface); cursor: pointer; transition: border-color 0.15s, background 0.15s; font-size: 0.88rem; color: var(--text); user-select: none; }
    .checkbox-item:hover { border-color: var(--primary); background: var(--primary-light); }
    .checkbox-item input[type="checkbox"] { width: 15px; height: 15px; margin: 0; flex-shrink: 0; accent-color: var(--primary); cursor: pointer; }
    .button-group { display: grid; grid-template-columns: 1fr 1fr; gap: 0.85rem; margin-top: 1.75rem; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.55rem; padding: 0.85rem 1rem; border: none; border-radius: var(--radius-sm); font-size: 0.95rem; font-weight: 600; font-family: var(--font); cursor: pointer; transition: all 0.18s; line-height: 1; }
    .btn:active { transform: scale(0.97); }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
    .btn-generate { background: var(--surface); color: var(--text); border: 1.5px solid var(--border); box-shadow: var(--shadow-sm); }
    .btn-generate:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); background: var(--primary-light); box-shadow: var(--shadow-md); }
    .btn-stream { background: var(--primary); color: #fff; box-shadow: 0 3px 10px var(--primary-shadow); }
    .btn-stream:hover:not(:disabled) { filter: brightness(1.08); box-shadow: 0 5px 16px var(--primary-shadow); transform: translateY(-1px); }
    .btn-download { background: var(--surface); color: var(--primary); border: 1.5px solid var(--primary); padding: 0.7rem 1.4rem; font-size: 0.9rem; }
    .btn-download:hover:not(:disabled) { background: var(--primary); color: #fff; box-shadow: 0 4px 12px var(--primary-shadow); }
    .status { margin-top: 1.25rem; padding: 0.8rem 1rem; border-radius: var(--radius-sm); font-size: 0.9rem; font-weight: 500; display: none; align-items: center; gap: 0.6rem; border: 1px solid transparent; }
    .status.show { display: flex; }
    .status-info { background: var(--info-light); color: var(--info); border-color: rgba(59,125,216,.2); }
    .status-success { background: var(--success-light); color: var(--success); border-color: rgba(45,158,107,.2); }
    .status-error { background: var(--error-light); color: var(--error); border-color: rgba(200,64,64,.2); }
    audio { width: 100%; margin-top: 1.25rem; border-radius: var(--radius-sm); height: 44px; }
    .download-section { margin-top: 0.85rem; display: flex; justify-content: center; }
    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.35); border-radius: 50%; border-top-color: currentColor; animation: spin 0.7s linear infinite; flex-shrink: 0; }
    .btn-generate .spinner { border-color: rgba(0,0,0,0.15); border-top-color: var(--primary); }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 720px) {
      .app-container { padding: 0 0 2rem; }
      .container { border-radius: 0; border-left: none; border-right: none; box-shadow: none; min-height: 100vh; }
      .page-header { padding: 1.5rem 1.25rem 1.25rem; }
      .page-body { padding: 1.25rem 1.25rem 2rem; }
      .grid-layout { grid-template-columns: 1fr; gap: 0; }
      .button-group { grid-template-columns: 1fr; }
      .checkbox-grid { grid-template-columns: 1fr 1fr; }
      .label-with-controls { flex-direction: column; align-items: flex-start; gap: 0.5rem; }
      .pause-controls { align-self: flex-end; }
    }
    @media (max-width: 480px) {
      .page-header { gap: 0.75rem; }
      .header-icon { width: 38px; height: 38px; }
      .header-text h1 { font-size: 1.15rem; }
      input[type="text"], input[type="password"], select, textarea { font-size: 16px; }
      .checkbox-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div id="app" class="app-container">
    <main class="container">
      <header class="page-header">
        <div class="header-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </div>
        <div class="header-text">
          <h1>TTS 语音合成</h1>
          <p>基于 Microsoft Edge TTS · 兼容 OpenAI 格式 · 支持情感标签</p>
        </div>
      </header>

      <div class="page-body">
        <details class="section-card">
          <summary>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            </svg>
            API 配置
            <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </summary>
          <div class="section-body">
            <div class="form-group">
              <label for="baseUrl">API Base URL</label>
              <input type="text" id="baseUrl" v-model="config.baseUrl" @input="saveConfig" placeholder="https://your-worker.workers.dev" />
            </div>
            <div class="form-group">
              <label for="apiKey">API Key</label>
              <input type="password" id="apiKey" v-model="config.apiKey" @input="saveConfig" placeholder="sk-..." />
            </div>
          </div>
        </details>

        <div class="form-group">
          <div class="label-with-controls">
            <label for="inputText">输入文本（支持情感标签）</label>
            <div class="pause-controls">
              <input type="number" v-model.number="pauseTime" min="0.01" max="100" step="0.01"
                placeholder="停顿秒数" class="pause-input" />
              <button type="button" @click="insertPause" class="btn-insert-pause">
                插入停顿
              </button>
            </div>
          </div>
          <textarea id="inputText" ref="textareaRef" v-model="form.inputText" @input="saveForm"
            placeholder="在此输入要转换的文本…&#10;&#10;支持情感标签，例如：&#10;[sarcastic] 你走错路了吧。&#10;[tender] 早点回来。&#10;[happy] 太好了！&#10;&#10;可用标签：happy, sad, angry, surprised, fear, hate, neutral, excited, gentle, shy, coquettish, teasing, doting, sympathetic, grateful, expectant, playful, relaxed, lazy, wronged, disappointed, jealous, envious, nervous, serious, confused, hesitant, firm, arrogant, humble, sarcastic, contemptuous, tender, lovey-dovey, depressed, guilt, pain, coldness, shout, crazy, whispering, breath, hum"></textarea>
          <div class="textarea-footer">
            <div class="char-counter" v-cloak>
              <span class="char-count-text" :class="charCountClass">{{ charCount }} 字符</span>
              <div class="char-bar">
                <div class="char-bar-fill" :class="charCountClass" :style="{ width: charBarWidth }"></div>
              </div>
            </div>
            <button class="clear-btn" @click="clearText">清除</button>
          </div>
        </div>

        <div class="grid-layout">
          <div class="form-group">
            <label for="voice">音色</label>
            <select id="voice" v-model="form.voice" @change="saveForm">
              <optgroup label="普通话 · 女声">
                <option value="zh-CN-XiaoxiaoNeural">晓晓（多风格 · 最热门）</option>
                <option value="zh-CN-XiaoyiNeural">晓伊（活泼）</option>
                <option value="zh-CN-XiaochenNeural">晓辰（开朗）</option>
                <option value="zh-CN-XiaohanNeural">晓涵（轻松）</option>
                <option value="zh-CN-XiaorouNeural">晓柔（温柔）</option>
                <option value="zh-CN-XiaoyanNeural">晓颜（专业）</option>
                <option value="zh-CN-XiaoqiuNeural">晓秋（沉稳）</option>
                <option value="zh-CN-XiaozhenNeural">晓甄（激情）</option>
                <option value="zh-CN-XiaomengNeural">晓梦（甜美清新）</option>
                <option value="zh-CN-XiaomoNeural">晓墨（多变表现力）</option>
                <option value="zh-CN-XiaoruiNeural">晓睿（年长）</option>
                <option value="zh-CN-XiaoshuangNeural">晓双（儿童）</option>
                <option value="zh-CN-XiaoyouNeural">晓悠（儿童）</option>
              </optgroup>
              <optgroup label="普通话 · 男声">
                <option value="zh-CN-YunyangNeural">云扬（专业 · 最热门）</option>
                <option value="zh-CN-YunxiNeural">云希（阳光）</option>
                <option value="zh-CN-YunjianNeural">云健（激情）</option>
                <option value="zh-CN-YunjieNeural">云杰（自然随性）</option>
                <option value="zh-CN-YunfengNeural">云枫（沉稳磁性）</option>
                <option value="zh-CN-YunhaoNeural">云皓（阳光活力）</option>
                <option value="zh-CN-YunzeNeural">云泽（浑厚）</option>
                <option value="zh-CN-YunyeNeural">云野（豪迈粗犷）</option>
                <option value="zh-CN-YunxiaNeural">云夏（儿童）</option>
              </optgroup>
              <optgroup label="地方方言">
                <option value="zh-CN-liaoning-XiaobeiNeural">晓北（辽宁 · 女）</option>
                <option value="zh-CN-liaoning-YunbiaoNeural">云彪（辽宁 · 男）</option>
                <option value="zh-CN-shaanxi-XiaoniNeural">晓妮（陕西 · 女）</option>
                <option value="zh-CN-henan-YundengNeural">云登（河南 · 男）</option>
                <option value="zh-CN-shandong-YunxiangNeural">云翔（山东 · 男）</option>
                <option value="zh-CN-sichuan-YunxiNeural">云希（四川 · 男）</option>
                <option value="zh-CN-guangxi-YunqiNeural">云琦（广西 · 男）</option>
              </optgroup>
              <optgroup label="台湾普通话">
                <option value="zh-TW-HsiaoChenNeural">曉臻（女）</option>
                <option value="zh-TW-HsiaoYuNeural">曉雨（女）</option>
                <option value="zh-TW-YunJheNeural">雲哲（男）</option>
              </optgroup>
              <optgroup label="粤语（香港）">
                <option value="zh-HK-HiuMaanNeural">曉曼（女）</option>
                <option value="zh-HK-HiuGaaiNeural">曉佳（女）</option>
                <option value="zh-HK-WanLungNeural">雲龍（男）</option>
              </optgroup>
              <optgroup label="英文 · 女声 (en-US)">
                <option value="en-US-JennyNeural">Jenny（最热门）</option>
                <option value="en-US-AriaNeural">Aria</option>
                <option value="en-US-MichelleNeural">Michelle</option>
                <option value="en-US-MonicaNeural">Monica</option>
                <option value="en-US-NancyNeural">Nancy</option>
                <option value="en-US-SaraNeural">Sara</option>
                <option value="en-US-AmberNeural">Amber</option>
                <option value="en-US-AshleyNeural">Ashley</option>
                <option value="en-US-CoraNeural">Cora</option>
                <option value="en-US-ElizabethNeural">Elizabeth</option>
                <option value="en-US-JaneNeural">Jane</option>
                <option value="en-US-AnaNeural">Ana（儿童）</option>
              </optgroup>
              <optgroup label="英文 · 男声 (en-US)">
                <option value="en-US-GuyNeural">Guy（最热门）</option>
                <option value="en-US-DavisNeural">Davis</option>
                <option value="en-US-ChristopherNeural">Christopher</option>
                <option value="en-US-EricNeural">Eric</option>
                <option value="en-US-RogerNeural">Roger</option>
                <option value="en-US-SteffanNeural">Steffan</option>
                <option value="en-US-BrandonNeural">Brandon</option>
                <option value="en-US-JasonNeural">Jason</option>
                <option value="en-US-TonyNeural">Tony</option>
                <option value="en-US-JacobNeural">Jacob</option>
              </optgroup>
            </select>
          </div>
          <div class="form-group">
            <label>语速</label>
            <div class="slider-group">
              <input type="range" v-model.number="form.speed" @input="saveForm" min="0.25" max="2.0" step="0.05" />
              <span class="slider-value" v-cloak>{{ speedDisplay }}</span>
            </div>
          </div>
          <div class="form-group">
            <label>音调</label>
            <div class="slider-group">
              <input type="range" v-model.number="form.pitch" @input="saveForm" min="0.5" max="1.5" step="0.05" />
              <span class="slider-value" v-cloak>{{ pitchDisplay }}</span>
            </div>
          </div>
        </div>

        <details class="section-card">
          <summary>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            高级文本清理
            <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </summary>
          <div class="section-body">
            <div class="checkbox-grid">
              <label class="checkbox-item">
                <input type="checkbox" v-model="form.cleaning.removeMarkdown" @change="saveForm" />
                移除 Markdown
              </label>
              <label class="checkbox-item">
                <input type="checkbox" v-model="form.cleaning.removeEmoji" @change="saveForm" />
                移除 Emoji
              </label>
              <label class="checkbox-item">
                <input type="checkbox" v-model="form.cleaning.removeUrls" @change="saveForm" />
                移除 URL
              </label>
              <label class="checkbox-item">
                <input type="checkbox" v-model="form.cleaning.removeLineBreaks" @change="saveForm" />
                移除空白换行
              </label>
              <label class="checkbox-item">
                <input type="checkbox" v-model="form.cleaning.removeCitation" @change="saveForm" />
                移除引用数字
              </label>
            </div>
            <div class="form-group" style="margin-top: 1rem;">
              <label for="customKeywords">自定义移除关键词（逗号分隔）</label>
              <input type="text" id="customKeywords" v-model="form.cleaning.customKeywords"
                @input="saveForm" placeholder="例如：广告词,品牌名" />
            </div>
          </div>
        </details>

        <div class="button-group">
          <button class="btn btn-generate" v-cloak :disabled="isLoading" @click="generateSpeech(false)">
            <span v-if="isLoading && !isStreaming" class="spinner"></span>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            {{ isLoading && !isStreaming ? '生成中…' : '生成语音' }}
          </button>
          <button class="btn btn-stream" v-cloak :disabled="isLoading" @click="generateSpeech(true)">
            <span v-if="isLoading && isStreaming" class="spinner"></span>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
            {{ isLoading && isStreaming ? '流式播放中…' : '流式生成' }}
          </button>
        </div>

        <div class="status" :class="['status-' + status.type, { show: status.show }]" v-cloak>
          {{ status.message }}
        </div>

        <audio ref="audioPlayer" controls v-show="audioSrc" v-cloak :src="audioSrc"
          @loadstart="onAudioLoadStart" @canplay="onAudioCanPlay"></audio>

        <div v-if="showDownloadBtn" class="download-section" v-cloak>
          <button class="btn btn-download" @click="downloadAudio">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            下载音频
          </button>
        </div>

      </div>
    </main>
  </div>

  <script src="https://unpkg.com/vue@3.5.33/dist/vue.global.prod.js"><\/script>

  <script>
    const { createApp } = Vue;
    const CHAR_WARN = 10000;
    const CHAR_LIMIT = 15000;

    createApp({
      data() {
        return {
          isLoading: false,
          isStreaming: false,
          audioSrc: '',
          downloadUrl: '',
          showDownloadBtn: false,
          pauseTime: 1.0,
          config: {
            baseUrl: '',
            apiKey: ''
          },
          form: {
            inputText: '',
            voice: 'zh-CN-XiaoxiaoNeural',
            speed: 1.0,
            pitch: 1.0,
            cleaning: {
              removeMarkdown: true,
              removeEmoji: true,
              removeUrls: true,
              removeLineBreaks: true,
              removeCitation: true,
              customKeywords: ''
            }
          },
          status: { show: false, message: '', type: 'info' }
        };
      },
      computed: {
        charCount() { return this.form.inputText.length; },
        speedDisplay() { return this.form.speed.toFixed(2); },
        pitchDisplay() { return this.form.pitch.toFixed(2); },
        charCountClass() {
          if (this.charCount >= CHAR_LIMIT) return 'danger';
          if (this.charCount >= CHAR_WARN) return 'warn';
          return '';
        },
        charBarWidth() {
          const pct = Math.min(this.charCount / CHAR_LIMIT * 100, 100);
          return pct + '%';
        }
      },
      methods: {
        loadConfig() {
          try {
            const saved = localStorage.getItem('tts_config');
            if (saved) {
              this.config = { ...this.config, ...JSON.parse(saved) };
              if (this.config.baseUrl.endsWith('/')) {
                this.config.baseUrl = this.config.baseUrl.slice(0, -1);
              }
            }
          } catch (e) { console.warn('Failed to load config:', e); }
        },
        saveConfig() {
          try { localStorage.setItem('tts_config', JSON.stringify(this.config)); }
          catch (e) { console.warn('Failed to save config:', e); }
        },
        loadForm() {
          try {
            const saved = localStorage.getItem('tts_form');
            if (saved) this.form = { ...this.form, ...JSON.parse(saved) };
          } catch (e) { console.warn('Failed to load form:', e); }
        },
        saveForm() {
          try { localStorage.setItem('tts_form', JSON.stringify(this.form)); }
          catch (e) { console.warn('Failed to save form:', e); }
        },
        clearText() { this.form.inputText = ''; this.saveForm(); },
        downloadAudio() {
          if (!this.downloadUrl) return;
          const link = document.createElement('a');
          link.href = this.downloadUrl;
          const ts = new Date().toLocaleString('sv').replace(/[: ]/g, '-');
          link.download = 'tts-' + ts + '.mp3';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        },
        updateStatus(message, type = 'info') {
          this.status = { show: true, message, type };
        },
        getRequestBody() {
          return {
            voice: this.form.voice,
            input: this.form.inputText.trim(),
            speed: this.form.speed,
            pitch: this.form.pitch,
            cleaning_options: {
              remove_markdown: this.form.cleaning.removeMarkdown,
              remove_emoji: this.form.cleaning.removeEmoji,
              remove_urls: this.form.cleaning.removeUrls,
              remove_line_breaks: this.form.cleaning.removeLineBreaks,
              remove_citation_numbers: this.form.cleaning.removeCitation,
              custom_keywords: this.form.cleaning.customKeywords,
            }
          };
        },
        async generateSpeech(isStream) {
          const baseUrl = this.config.baseUrl.trim();
          const apiKey = this.config.apiKey.trim();
          const text = this.form.inputText.trim();
          if (!baseUrl || !apiKey || !text) {
            this.updateStatus('请填写 API 配置和输入文本', 'error');
            return;
          }
          const body = { ...this.getRequestBody(), stream: isStream };
          this.isLoading = true;
          this.isStreaming = isStream;
          this.audioSrc = '';
          this.showDownloadBtn = false;
          if (this.downloadUrl) { URL.revokeObjectURL(this.downloadUrl); this.downloadUrl = ''; }
          this.updateStatus('正在连接服务器…', 'info');
          try {
            if (isStream) await this.playStreamWithMSE(baseUrl, apiKey, body);
            else await this.playStandard(baseUrl, apiKey, body);
          } catch (err) {
            console.error(err);
            this.updateStatus('错误：' + err.message, 'error');
          } finally {
            this.isLoading = false;
            this.isStreaming = false;
          }
        },
        async playStandard(baseUrl, apiKey, body) {
          const res = await fetch(baseUrl + '/v1/audio/speech', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          if (!res.ok) {
            const d = await res.json();
            throw new Error(d.error?.message || 'HTTP ' + res.status);
          }
          const blob = await res.blob();
          this.audioSrc = URL.createObjectURL(blob);
          this.downloadUrl = this.audioSrc;
          this.showDownloadBtn = true;
          this.updateStatus('生成完毕，正在播放…', 'success');
          this.$nextTick(() => this.$refs.audioPlayer.play().catch(() => {}));
        },
        async playStreamWithMSE(baseUrl, apiKey, body) {
          const mediaSource = new MediaSource();
          const srcUrl = URL.createObjectURL(mediaSource);
          this.audioSrc = srcUrl;
          const audioChunks = [];
          return new Promise((resolve, reject) => {
            mediaSource.addEventListener('sourceopen', async () => {
              const sb = mediaSource.addSourceBuffer('audio/mpeg');
              try {
                const res = await fetch(baseUrl + '/v1/audio/speech', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
                  body: JSON.stringify(body)
                });
                if (!res.ok) {
                  const d = await res.json();
                  throw new Error(d.error?.message || 'HTTP ' + res.status);
                }
                this.updateStatus('已连接，正在接收数据…', 'info');
                this.$nextTick(() => this.$refs.audioPlayer.play().catch(() => {}));
                const reader = res.body.getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    if (mediaSource.readyState === 'open' && !sb.updating) mediaSource.endOfStream();
                    this.downloadUrl = URL.createObjectURL(new Blob(audioChunks, { type: 'audio/mpeg' }));
                    this.showDownloadBtn = true;
                    this.updateStatus('播放完毕，可下载保存', 'success');
                    resolve();
                    return;
                  }
                  audioChunks.push(value.slice());
                  if (sb.updating) {
                    await new Promise(r => sb.addEventListener('updateend', r, { once: true }));
                  }
                  sb.appendBuffer(value);
                  this.updateStatus('正在流式播放…', 'success');
                }
              } catch (err) {
                this.updateStatus('错误：' + err.message, 'error');
                if (mediaSource.readyState === 'open') try { mediaSource.endOfStream(); } catch (_) {}
                reject(err);
              }
            }, { once: true });
          });
        },
        onAudioLoadStart() {},
        onAudioCanPlay() {},
        insertPause() {
          const ta = this.$refs.textareaRef;
          if (!ta) return;
          if (!this.pauseTime || this.pauseTime <= 0 || this.pauseTime > 100) {
            alert('停顿时间必须在 0.01 到 100 秒之间');
            return;
          }
          const s = ta.selectionStart, e = ta.selectionEnd;
          const tag = '<break time="' + this.pauseTime + 's"/>';
          this.form.inputText = this.form.inputText.slice(0, s) + tag + this.form.inputText.slice(e);
          this.$nextTick(() => { ta.focus(); ta.setSelectionRange(s + tag.length, s + tag.length); });
        }
      },
      mounted() { this.loadConfig(); this.loadForm(); },
      beforeUnmount() {
        if (this.audioSrc) URL.revokeObjectURL(this.audioSrc);
        if (this.downloadUrl && this.downloadUrl !== this.audioSrc) URL.revokeObjectURL(this.downloadUrl);
      }
    }).mount('#app');
  <\/script>
</body>
</html>
`;
}