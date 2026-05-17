// ============================================================
//  GYM AI RECEPTIONIST — Exotel Voicebot WebSocket Server v4
//  Sends audio as base64 mulaw 8000hz chunks via media events
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
Speak naturally and warmly. Keep answers under 25 words - this is a voice call.

GYM INFO:
- Location: Koramangala 5th Block, Bengaluru
- Timings: Mon-Sat 5:30 AM-10:30 PM, Sunday 6 AM-8 PM
- Memberships: Basic 1999/month, Premium 2999/month, Quarterly 5999, Annual 19999
- Personal Trainers: 6 certified PTs from 499/session
- Free trial: 1-day free pass available
- Facilities: AC gym, cardio, free weights, group studio, steam room, protein bar`;

async function getAIResponse(messages) {
  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'system', content: GYM_PROMPT }, ...messages],
        max_tokens: 80,
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

// ElevenLabs → mulaw 8000hz base64
async function textToMulawBase64(text) {
  try {
    // Try ulaw_8000 format first
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        output_format: 'mp3_44100_128',
      },
      {
        headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
      }
    );
    const b64 = Buffer.from(res.data).toString('base64');
    console.log('✅ Got mulaw audio, size:', res.data.byteLength, 'bytes');
    return b64;
  } catch (err) {
    console.error('ElevenLabs mulaw error:', err.response?.status, err.response?.data?.toString()?.substring(0, 100));
    // Fallback: try mp3_44100
    try {
      const res2 = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
        {
          text,
          model_id: 'eleven_turbo_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        },
        {
          headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
          responseType: 'arraybuffer',
        }
      );
      console.log('✅ Got mp3 audio fallback, size:', res2.data.byteLength);
      return Buffer.from(res2.data).toString('base64');
    } catch (err2) {
      console.error('ElevenLabs mp3 fallback error:', err2.message);
      return null;
    }
  }
}

wss.on('connection', (ws, req) => {
  console.log('🔌 WS connected');
  const messages = [];
  let streamSid = null;
  let mediaFormat = null;

  const sendAudio = async (text) => {
    console.log('🤖 Speaking:', text);
    const audioB64 = await textToMulawBase64(text);
    if (!audioB64 || ws.readyState !== WebSocket.OPEN) return;

    // Send as Exotel media event with payload
    const mediaMsg = {
      event: 'media',
      streamSid,
      media: { payload: audioB64 }
    };
    ws.send(JSON.stringify(mediaMsg));
    console.log('📤 Sent media event with audio payload');

    // Send mark to signal end
    ws.send(JSON.stringify({
      event: 'mark',
      streamSid,
      mark: { name: 'audio_done' }
    }));
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    const evt = msg.event;

    if (evt === 'connected') {
      console.log('✅ Exotel connected event received');

    } else if (evt === 'start') {
      streamSid = msg.start?.streamSid || msg.stream_sid;
      mediaFormat = msg.start?.mediaFormat || msg.start?.media_format;
      console.log('📞 Call started');
      console.log('   streamSid:', streamSid);
      console.log('   mediaFormat:', JSON.stringify(mediaFormat));
      console.log('   from:', msg.start?.from || msg.start?.customParameters?.from);

      // Send greeting
      const greeting = await getAIResponse([
        { role: 'user', content: 'Customer just called. Give warm greeting under 20 words.' }
      ]);
      messages.push({ role: 'assistant', content: greeting });
      await sendAudio(greeting);

    } else if (evt === 'media') {
      // Incoming audio from caller — Exotel handles STT
      // We just wait for transcript events

    } else if (evt === 'transcript' || evt === 'transcription') {
      const text = msg.transcript?.text || msg.transcript || msg.text || '';
      const isFinal = msg.transcript?.is_final !== false;
      if (!text.trim() || !isFinal) return;
      console.log('🎤 Caller:', text);
      messages.push({ role: 'user', content: text });
      const reply = await getAIResponse(messages);
      messages.push({ role: 'assistant', content: reply });
      await sendAudio(reply);

    } else if (evt === 'dtmf') {
      console.log('🔢 DTMF digit:', msg.dtmf?.digit);

    } else if (evt === 'stop') {
      console.log('📴 Call ended, reason:', msg.stop?.reason);

    } else if (evt !== 'media') {
      console.log('❓ Unknown event:', evt, JSON.stringify(msg).substring(0, 200));
    }
  });

  ws.on('close', () => console.log('🔌 Disconnected'));
  ws.on('error', (e) => console.error('WS error:', e.message));
});

app.get('/', (req, res) => res.json({ status: '🏋️ Gym AI Receptionist running!' }));

server.listen(CONFIG.PORT, () => console.log(`🏋️ Live on port ${CONFIG.PORT}`));
