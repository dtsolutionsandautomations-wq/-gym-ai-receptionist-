// ============================================================
//  GYM AI RECEPTIONIST — WebSocket Server for Exotel Voicebot
//  Stack: Exotel Voicebot (ws) + Groq AI (free) + ElevenLabs (voice)
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
console.log('  BASE_URL:', CONFIG.BASE_URL);
console.log('  GROQ_API_KEY:', CONFIG.GROQ_API_KEY ? 'SET' : 'MISSING');
console.log('  ELEVENLABS_API_KEY:', CONFIG.ELEVENLABS_API_KEY ? 'SET' : 'MISSING');

const GYM_PROFILE = {
  name: 'Titan Fitness Gym',
  systemPrompt: `You are Priya, the friendly AI receptionist at Titan Fitness Gym in Bengaluru.
Speak naturally and warmly like a real human receptionist on a phone call.
Keep answers SHORT - max 2-3 sentences since this is a voice call.
You can mix a little Hindi naturally (e.g. "bilkul", "zaroor").

GYM INFORMATION:
- Location: Koramangala 5th Block, Bengaluru
- Timings: Mon-Sat 5:30 AM to 10:30 PM, Sunday 6 AM to 8 PM
- Memberships: Basic 1999 rupees/month | Premium 2999 rupees/month (includes classes) | Quarterly 5999 | Annual 19999
- Personal Trainers: 6 certified PTs, sessions from 499 rupees
- Free trial: Yes, 1-day free pass available
- Facilities: AC gym, cardio zone, free weights, group studio, steam room, protein bar

RULES:
- Keep responses under 30 words for voice
- For trial booking ask their name and preferred date
- End calls with: "Thank you for calling Titan Fitness! Have a great day!"`,
};

// Groq AI
async function getAIResponse(messages) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: GYM_PROFILE.systemPrompt },
        ...messages
      ],
      max_tokens: 100,
      temperature: 0.7,
    },
    {
      headers: {
        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content;
}

// ElevenLabs TTS — returns base64 audio
async function textToSpeechBase64(text) {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    {
      headers: {
        'xi-api-key': CONFIG.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer',
    }
  );
  return Buffer.from(response.data).toString('base64');
}

// Serve audio files
app.get('/audio/:filename', (req, res) => {
  const filepath = path.join('/tmp', req.params.filename);
  if (fs.existsSync(filepath)) {
    res.set('Content-Type', 'audio/mpeg');
    res.sendFile(filepath);
    setTimeout(() => fs.existsSync(filepath) && fs.unlinkSync(filepath), 60000);
  } else {
    res.status(404).send('Not found');
  }
});

// HTTP endpoint for Exotel Passthru (backup)
app.all('/incoming-call', async (req, res) => {
  console.log('📞 HTTP incoming call');
  try {
    const greeting = await getAIResponse([
      { role: 'user', content: 'Customer just called. Give a warm short greeting.' }
    ]);
    console.log('🤖 Greeting:', greeting);

    const audioData = await textToSpeechBase64(greeting);
    const filename = `speech_${Date.now()}.mp3`;
    fs.writeFileSync(path.join('/tmp', filename), Buffer.from(audioData, 'base64'));

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${CONFIG.BASE_URL}/audio/${filename}</Play>
  <Gather input="speech" action="${CONFIG.BASE_URL}/process-speech" speechTimeout="auto" language="en-IN">
  </Gather>
  <Redirect>${CONFIG.BASE_URL}/no-input</Redirect>
</Response>`;
    res.type('text/xml');
    res.send(xml);
  } catch (err) {
    console.error('Error:', err.message);
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, technical issue. Please call back.</Say><Hangup/></Response>`);
  }
});

app.all('/process-speech', async (req, res) => {
  const speech = req.body?.SpeechResult || req.query?.SpeechResult || '';
  console.log('🎤 Speech:', speech);
  try {
    const reply = await getAIResponse([
      { role: 'user', content: speech || 'Hello' }
    ]);
    console.log('🤖 Reply:', reply);

    const audioData = await textToSpeechBase64(reply);
    const filename = `speech_${Date.now()}.mp3`;
    fs.writeFileSync(path.join('/tmp', filename), Buffer.from(audioData, 'base64'));

    const endKeywords = ['bye', 'goodbye', 'thank you bye', 'ok bye'];
    const isEnding = endKeywords.some(kw => speech.toLowerCase().includes(kw));

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${CONFIG.BASE_URL}/audio/${filename}</Play>
  ${isEnding ? '<Hangup/>' : `<Gather input="speech" action="${CONFIG.BASE_URL}/process-speech" speechTimeout="auto" language="en-IN"></Gather><Redirect>${CONFIG.BASE_URL}/no-input</Redirect>`}
</Response>`;
    res.type('text/xml');
    res.send(xml);
  } catch (err) {
    console.error('Error:', err.message);
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, one moment please.</Say><Redirect>${CONFIG.BASE_URL}/no-input</Redirect></Response>`);
  }
});

app.all('/no-input', async (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman" language="en-IN">Sorry, I didn't catch that. Could you please repeat?</Say>
  <Gather input="speech" action="${CONFIG.BASE_URL}/process-speech" speechTimeout="auto" language="en-IN"></Gather>
</Response>`);
});

// ── WEBSOCKET for Exotel Voicebot ────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('🔌 WebSocket connected:', req.url);
  const messages = [];
  let isGreeted = false;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('📨 WS message type:', msg.event || msg.type);

      // Exotel Voicebot sends 'start' event first
      if (msg.event === 'start' || !isGreeted) {
        isGreeted = true;
        const greeting = await getAIResponse([
          { role: 'user', content: 'Customer just called. Give a warm short greeting in under 20 words.' }
        ]);
        console.log('🤖 WS Greeting:', greeting);
        const audioB64 = await textToSpeechBase64(greeting);
        ws.send(JSON.stringify({ event: 'playAudio', audio: audioB64, encoding: 'mp3' }));
        messages.push({ role: 'assistant', content: greeting });
        return;
      }

      // Speech transcript from caller
      if (msg.event === 'transcript' || msg.text || msg.speech) {
        const userText = msg.text || msg.speech || msg.transcript || '';
        if (!userText.trim()) return;
        console.log('🎤 WS Speech:', userText);
        messages.push({ role: 'user', content: userText });

        const reply = await getAIResponse(messages);
        console.log('🤖 WS Reply:', reply);
        messages.push({ role: 'assistant', content: reply });

        const audioB64 = await textToSpeechBase64(reply);
        ws.send(JSON.stringify({ event: 'playAudio', audio: audioB64, encoding: 'mp3' }));
      }
    } catch (err) {
      console.error('WS error:', err.message);
    }
  });

  ws.on('close', () => console.log('🔌 WebSocket disconnected'));
  ws.on('error', (err) => console.error('WS error:', err.message));
});

app.get('/', (req, res) => {
  res.json({ status: '🏋️ Gym AI Receptionist running!', wsUrl: `wss://gym-ai-receptionist.onrender.com` });
});

server.listen(CONFIG.PORT, () => {
  console.log(`🏋️  Gym AI Receptionist live on port ${CONFIG.PORT}`);
});
