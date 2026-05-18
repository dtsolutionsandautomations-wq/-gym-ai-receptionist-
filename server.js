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

const GYM_PROMPT = `You are Priya, friendly AI receptionist at Titan Fitness Gym in Bengaluru.
Keep answers under 20 words.
Memberships: Basic 1999/mo, Premium 2999/mo | Timings: Mon-Sat 5:30AM-10:30PM | Free trial available`;

const conversations = new Map();

async function getAI(sid, text) {
  if (!conversations.has(sid)) conversations.set(sid, []);
  const h = conversations.get(sid);
  h.push({ role: 'user', content: text });
  try {
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.1-8b-instant', messages: [{ role: 'system', content: GYM_PROMPT }, ...h], max_tokens: 60 },
      { headers: { 'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}` } }
    );
    const reply = r.data.choices[0].message.content.trim();
    h.push({ role: 'assistant', content: reply });
    return reply;
  } catch (e) { return "Welcome to Titan Fitness! How can I help?"; }
}

// PCM 16bit LE to mulaw 8bit
function pcm16ToMulaw(pcmBuf) {
  const out = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < out.length; i++) {
    let s = pcmBuf.readInt16LE(i * 2);
    const sign = s < 0 ? 0x80 : 0;
    if (s < 0) s = -s;
    if (s > 32635) s = 32635;
    s += 132;
    let exp = 7;
    for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1) {}
    const man = (s >> (exp + 3)) & 0x0f;
    out[i] = (~(sign | (exp << 4) | man)) & 0xff;
  }
  return out;
}

async function ttsToMulaw(text) {
  // Get PCM 8000hz from ElevenLabs
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
    { text, model_id: 'eleven_turbo_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 }, output_format: 'mp3_22050_32' },
    { headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' }
  );
  const pcm = Buffer.from(r.data);
  const mulaw = pcm16ToMulaw(pcm);
  console.log(`✅ PCM ${pcm.length}b → mulaw ${mulaw.length}b`);
  return mulaw.toString('base64');
}

wss.on('connection', (ws) => {
  console.log('🔌 Connected');
  let sid = null;
  // Collect incoming audio chunks for STT
  const audioChunks = [];
  let silenceTimer = null;

  const speak = async (text) => {
    console.log('🤖', text);
    try {
      const b64 = await ttsToMulaw(text);
      if (ws.readyState !== WebSocket.OPEN) return;
      // Send as single media event
      ws.send(JSON.stringify({
        event: 'media',
        streamSid: sid,
        media: { payload: b64 }
      }));
      ws.send(JSON.stringify({ event: 'mark', streamSid: sid, mark: { name: 'done' } }));
      console.log('📤 Done');
    } catch (e) { console.error('TTS error:', e.message); }
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const e = msg.event;

    if (e === 'start') {
      sid = msg.start?.streamSid;
      const fmt = msg.start?.mediaFormat || msg.start?.media_format || {};
      console.log('📞 Started:', sid);
      console.log('   Format:', JSON.stringify(fmt));
      const greeting = await getAI(sid, 'Customer called. Give warm short greeting under 12 words.');
      await speak(greeting);

    } else if (e === 'media') {
      // Collect audio for STT processing
      if (msg.media?.payload) {
        audioChunks.push(msg.media.payload);
        // Reset silence timer — when silence detected, process speech
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(async () => {
          if (audioChunks.length < 10) { audioChunks.length = 0; return; }
          console.log('🎤 Processing', audioChunks.length, 'audio chunks via STT...');
          // For now use a placeholder — in production use Google STT or Deepgram
          // Since we can't do STT without another API, respond generically
          audioChunks.length = 0;
          const reply = await getAI(sid, 'Customer spoke. Ask them what they need help with at the gym.');
          await speak(reply);
        }, 1500); // 1.5 second silence = end of speech
      }

    } else if (e === 'transcript' || e === 'transcription') {
      const t = msg.transcript?.text || msg.transcript || msg.text || '';
      if (!t.trim()) return;
      console.log('🎤 Transcript:', t);
      if (silenceTimer) clearTimeout(silenceTimer);
      audioChunks.length = 0;
      const reply = await getAI(sid, t);
      await speak(reply);

    } else if (e === 'stop') {
      console.log('📴 Ended');
      if (silenceTimer) clearTimeout(silenceTimer);
    } else if (e !== 'media' && e !== 'connected') {
      console.log('❓ Event:', e, JSON.stringify(msg).substring(0, 150));
    }
  });

  ws.on('close', () => console.log('🔌 Closed'));
  ws.on('error', e => console.error('WS error:', e.message));
});

app.get('/', (req, res) => res.json({ status: '🏋️ Running' }));
server.listen(CONFIG.PORT, () => console.log(`🏋️ Port ${CONFIG.PORT}`));
