// ============================================================
//  GYM AI RECEPTIONIST — Final Version
//  Exotel Voicebot + Groq AI + ElevenLabs
//  Proper mulaw 8000hz audio conversion for Exotel
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
  PORT: process.env.PORT || 3000,
};

console.log('GROQ_API_KEY:', CONFIG.GROQ_API_KEY ? 'SET' : 'MISSING');
console.log('ELEVENLABS_API_KEY:', CONFIG.ELEVENLABS_API_KEY ? 'SET' : 'MISSING');

const GYM_PROMPT = `You are Priya, friendly AI receptionist at Titan Fitness Gym in Bengaluru.
Speak naturally and warmly. Keep answers under 20 words - this is a phone call.

GYM INFO:
- Location: Koramangala 5th Block, Bengaluru
- Timings: Mon-Sat 5:30 AM-10:30 PM, Sunday 6 AM-8 PM
- Memberships: Basic 1999/month, Premium 2999/month, Quarterly 5999, Annual 19999
- Personal Trainers: 6 certified PTs from 499/session
- Free trial: 1-day free pass available
- Facilities: AC gym, cardio, free weights, group studio, steam room, protein bar`;

// Linear PCM to mulaw conversion
function pcmToMulaw(pcmBuffer) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const mulawBuffer = Buffer.alloc(pcmBuffer.length / 2);
  
  for (let i = 0; i < mulawBuffer.length; i++) {
    let sample = pcmBuffer.readInt16LE(i * 2);
    const sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exp = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exp > 0; exp--, expMask >>= 1) {}
    const mantissa = (sample >> (exp + 3)) & 0x0f;
    mulawBuffer[i] = ~(sign | (exp << 4) | mantissa) & 0xff;
  }
  return mulawBuffer;
}

async function getAIResponse(messages) {
  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'system', content: GYM_PROMPT }, ...messages],
        max_tokens: 60,
        temperature: 0.7,
      },
      { headers: { 'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}` } }
    );
    return res.data.choices[0].message.content.trim();
  } catch (err) {
    console.error('Groq error:', err.message);
    return "Welcome to Titan Fitness Gym! How can I help you?";
  }
}

// Get PCM 8000hz audio from ElevenLabs, convert to mulaw
async function textToMulaw8000(text) {
  try {
    // Get PCM 16bit 8000hz from ElevenLabs
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        output_format: 'pcm_8000',
      },
      {
        headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
      }
    );

    const pcmBuffer = Buffer.from(res.data);
    console.log('✅ PCM audio received, size:', pcmBuffer.length);
    
    // Convert PCM to mulaw
    const mulawBuffer = pcmToMulaw(pcmBuffer);
    console.log('✅ Converted to mulaw, size:', mulawBuffer.length);
    
    return mulawBuffer.toString('base64');
  } catch (err) {
    console.error('ElevenLabs error:', err.response?.status, err.message);
    return null;
  }
}

wss.on('connection', (ws) => {
  console.log('🔌 WS connected');
  const messages = [];
  let streamSid = null;

  const sendAudio = async (text) => {
    console.log('🤖 Speaking:', text);
    const audioB64 = await textToMulaw8000(text);
    if (!audioB64 || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: audioB64 }
    }));

    ws.send(JSON.stringify({
      event: 'mark',
      streamSid,
      mark: { name: 'done' }
    }));
    console.log('📤 Audio sent');
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const evt = msg.event;

    if (evt === 'connected') {
      console.log('✅ Connected');

    } else if (evt === 'start') {
      streamSid = msg.start?.streamSid;
      console.log('📞 Call started, streamSid:', streamSid);
      const greeting = await getAIResponse([
        { role: 'user', content: 'Customer called. Give warm greeting under 15 words.' }
      ]);
      messages.push({ role: 'assistant', content: greeting });
      await sendAudio(greeting);

    } else if (evt === 'media') {
      // Incoming audio — ignore, wait for transcript

    } else if (evt === 'transcript' || evt === 'transcription') {
      const text = msg.transcript?.text || msg.transcript || msg.text || '';
      if (!text.trim()) return;
      console.log('🎤 Caller:', text);
      messages.push({ role: 'user', content: text });
      const reply = await getAIResponse(messages);
      messages.push({ role: 'assistant', content: reply });
      await sendAudio(reply);

    } else if (evt === 'dtmf') {
      console.log('🔢 DTMF:', msg.dtmf?.digit);

    } else if (evt === 'stop') {
      console.log('📴 Call ended');

    } else if (evt !== 'media') {
      console.log('❓ Event:', evt, JSON.stringify(msg).substring(0, 150));
      // Check for any speech/text in unknown events
      const text = msg.text || msg.speech || msg.utterance || '';
      if (text.trim()) {
        console.log('🎤 Speech found:', text);
        messages.push({ role: 'user', content: text });
        const reply = await getAIResponse(messages);
        messages.push({ role: 'assistant', content: reply });
        await sendAudio(reply);
      }
    }
  });

  ws.on('close', () => console.log('🔌 Disconnected'));
  ws.on('error', (e) => console.error('WS error:', e.message));
});

app.get('/', (req, res) => res.json({ status: '🏋️ Gym AI Receptionist running!' }));

server.listen(CONFIG.PORT, () => console.log(`🏋️ Live on port ${CONFIG.PORT}`));
