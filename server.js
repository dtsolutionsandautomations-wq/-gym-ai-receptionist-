// ============================================================
//  GYM AI RECEPTIONIST — Exotel Voicebot WebSocket Server v3
//  Using MP3 audio with proper Exotel media event format
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
  BASE_URL: process.env.BASE_URL || 'https://gym-ai-receptionist.onrender.com',
  PORT: process.env.PORT || 3000,
};

console.log('CONFIG CHECK:');
console.log('  GROQ_API_KEY:', CONFIG.GROQ_API_KEY ? 'SET' : 'MISSING');
console.log('  ELEVENLABS_API_KEY:', CONFIG.ELEVENLABS_API_KEY ? 'SET' : 'MISSING');
console.log('  BASE_URL:', CONFIG.BASE_URL);

const GYM_PROMPT = `You are Priya, friendly AI receptionist at Titan Fitness Gym in Bengaluru.
Speak naturally and warmly. Keep answers SHORT - max 2 sentences for voice calls.

GYM INFO:
- Location: Koramangala 5th Block, Bengaluru
- Timings: Mon-Sat 5:30 AM-10:30 PM, Sunday 6 AM-8 PM
- Memberships: Basic 1999/month, Premium 2999/month, Quarterly 5999, Annual 19999
- Personal Trainers: 6 certified PTs from 499/session
- Free trial: Yes, 1-day free pass
- Facilities: AC gym, cardio, free weights, group studio, steam room, protein bar

Keep responses under 25 words. For trial ask name and date.`;

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
    return "Namaste! Welcome to Titan Fitness Gym. How can I help you?";
  }
}

// Get audio as MP3 buffer from ElevenLabs
async function getAudioBuffer(text) {
  try {
    const res = await axios.post(
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
    return Buffer.from(res.data);
  } catch (err) {
    console.error('ElevenLabs error:', err.response?.status, err.message);
    return null;
  }
}

// Save audio and return URL
async function getAudioUrl(text) {
  const buf = await getAudioBuffer(text);
  if (!buf) return null;
  const filename = `speech_${Date.now()}.mp3`;
  fs.writeFileSync(path.join('/tmp', filename), buf);
  return `${CONFIG.BASE_URL}/audio/${filename}`;
}

// Serve audio
app.get('/audio/:filename', (req, res) => {
  const fp = path.join('/tmp', req.params.filename);
  if (fs.existsSync(fp)) {
    res.set('Content-Type', 'audio/mpeg');
    res.sendFile(fp);
    setTimeout(() => fs.existsSync(fp) && fs.unlinkSync(fp), 60000);
  } else {
    res.status(404).send('Not found');
  }
});

// WebSocket — Exotel Voicebot
wss.on('connection', (ws, req) => {
  console.log('🔌 WS connected from:', req.socket.remoteAddress);
  const messages = [];
  let streamSid = null;
  let allEvents = new Set();

  const playText = async (text) => {
    console.log('🤖 Speaking:', text);
    const audioUrl = await getAudioUrl(text);
    if (!audioUrl) return;

    // Try multiple response formats that Exotel might expect
    if (ws.readyState !== WebSocket.OPEN) return;

    // Format 1: playAudio event
    ws.send(JSON.stringify({
      event: 'playAudio',
      streamSid,
      playAudio: { url: audioUrl }
    }));

    // Format 2: media with URL
    ws.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { url: audioUrl }
    }));

    console.log('📤 Sent audio URL:', audioUrl);
  };

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.log('📨 Binary/non-JSON data received, length:', raw.length);
      return;
    }

    const evt = msg.event || 'unknown';
    if (!allEvents.has(evt)) {
      allEvents.add(evt);
      console.log('📨 New event type:', evt, JSON.stringify(msg).substring(0, 200));
    }

    if (evt === 'start') {
      streamSid = msg.start?.streamSid || msg.streamSid || 'sid_' + Date.now();
      console.log('📞 Call started, streamSid:', streamSid);
      const greeting = await getAIResponse([
        { role: 'user', content: 'Customer called. Greet them warmly in under 20 words.' }
      ]);
      messages.push({ role: 'assistant', content: greeting });
      await playText(greeting);

    } else if (evt === 'transcript' || evt === 'transcription' || evt === 'speech') {
      const text = msg.transcript || msg.text || msg.speech || msg.utterance || '';
      if (!text.trim()) return;
      console.log('🎤 Customer:', text);
      messages.push({ role: 'user', content: text });
      const reply = await getAIResponse(messages);
      messages.push({ role: 'assistant', content: reply });
      await playText(reply);

    } else if (evt === 'stop') {
      console.log('📴 Call ended');
    }
    // Log ALL non-media events fully so we can learn the protocol
    if (evt !== 'media') {
      console.log('FULL EVENT:', JSON.stringify(msg).substring(0, 300));
    }
  });

  ws.on('close', () => {
    console.log('🔌 WS disconnected. All events seen:', [...allEvents].join(', '));
  });
  ws.on('error', (err) => console.error('WS error:', err.message));
});

app.get('/', (req, res) => res.json({ status: '🏋️ Running', wsUrl: 'wss://gym-ai-receptionist.onrender.com' }));

server.listen(CONFIG.PORT, () => console.log(`🏋️ Live on port ${CONFIG.PORT}`));
