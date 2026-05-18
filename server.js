// Exotel Voicebot — correct audio format: 16-bit PCM slin 8kHz base64
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
  PORT: process.env.PORT || 3000,
};

console.log('GROQ:', CONFIG.GROQ_API_KEY ? 'SET' : 'MISSING');
console.log('ELEVENLABS:', CONFIG.ELEVENLABS_API_KEY ? 'SET' : 'MISSING');

const GYM_PROMPT = `You are Priya, friendly AI receptionist at Titan Fitness Gym in Bengaluru.
Keep answers under 20 words - phone call.
GYM: Koramangala 5th Block | Mon-Sat 5:30AM-10:30PM Sun 6AM-8PM
Memberships: Basic 1999/mo, Premium 2999/mo, Quarterly 5999, Annual 19999
PTs: 6 certified from 499/session | Free trial: 1-day pass`;

const conversations = new Map();

async function getAI(callSid, text) {
  if (!conversations.has(callSid)) conversations.set(callSid, []);
  const hist = conversations.get(callSid);
  hist.push({ role: 'user', content: text });
  try {
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.1-8b-instant', messages: [{ role: 'system', content: GYM_PROMPT }, ...hist], max_tokens: 60 },
      { headers: { 'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}` } }
    );
    const reply = r.data.choices[0].message.content.trim();
    hist.push({ role: 'assistant', content: reply });
    return reply;
  } catch (e) {
    console.error('Groq:', e.message);
    return "Welcome to Titan Fitness! How can I help you?";
  }
}

// ElevenLabs PCM 8000hz (slin) → base64
async function tts(text) {
  try {
    const r = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
      { text, model_id: 'eleven_turbo_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 }, output_format: 'pcm_8000' },
      { headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' }
    );
    console.log('✅ TTS bytes:', r.data.byteLength);
    return Buffer.from(r.data).toString('base64');
  } catch (e) {
    console.error('ElevenLabs:', e.response?.status, e.message);
    return null;
  }
}

wss.on('connection', (ws, req) => {
  // Check if sample_rate is requested in URL
  const url = new URL(req.url, 'http://localhost');
  const sampleRate = url.searchParams.get('sample_rate') || '8000';
  console.log('🔌 WS connected, sample_rate:', sampleRate);

  const msgs = [];
  let streamSid = null;

  const speak = async (text) => {
    console.log('🤖', text);
    const audio = await tts(text);
    if (!audio || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: audio } }));
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'done' } }));
    console.log('📤 Sent');
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const e = msg.event;

    if (e === 'connected') {
      console.log('✅ Connected');
    } else if (e === 'start') {
      streamSid = msg.start?.streamSid;
      console.log('📞 Started, sid:', streamSid);
      console.log('   format:', JSON.stringify(msg.start?.mediaFormat || msg.start?.media_format));
      const greeting = await getAI(streamSid, 'Customer called. Greet warmly under 15 words.');
      msgs.push({ role: 'assistant', content: greeting });
      await speak(greeting);
    } else if (e === 'transcript' || e === 'transcription') {
      const t = msg.transcript?.text || msg.transcript || msg.text || '';
      if (!t.trim()) return;
      console.log('🎤', t);
      const reply = await getAI(streamSid, t);
      await speak(reply);
    } else if (e === 'stop') {
      console.log('📴 Ended');
    } else if (e !== 'media') {
      console.log('❓', e, JSON.stringify(msg).substring(0, 100));
      const t = msg.text || msg.speech || msg.utterance || '';
      if (t.trim()) {
        const reply = await getAI(streamSid || 'default', t);
        await speak(reply);
      }
    }
  });

  ws.on('close', () => console.log('🔌 Closed'));
  ws.on('error', e => console.error('WS:', e.message));
});

app.get('/', (req, res) => res.json({ status: '🏋️ Running' }));
server.listen(CONFIG.PORT, () => console.log(`🏋️ Port ${CONFIG.PORT}`));
