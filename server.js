const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
  BASE_URL: process.env.BASE_URL || 'https://gym-ai-receptionist.onrender.com',
  PORT: process.env.PORT || 3000,
};

console.log('GROQ:', CONFIG.GROQ_API_KEY ? 'SET' : 'MISSING');
console.log('ELEVENLABS:', CONFIG.ELEVENLABS_API_KEY ? 'SET' : 'MISSING');
console.log('BASE_URL:', CONFIG.BASE_URL);

const GYM_PROMPT = `You are Priya, friendly AI receptionist at Titan Fitness Gym in Bengaluru.
Keep answers under 20 words - this is a phone call.
GYM INFO:
- Location: Koramangala 5th Block, Bengaluru
- Timings: Mon-Sat 5:30 AM-10:30 PM, Sunday 6 AM-8 PM
- Memberships: Basic 1999/month, Premium 2999/month, Quarterly 5999, Annual 19999
- Personal Trainers: 6 certified PTs from 499/session
- Free trial: 1-day free pass available`;

const conversations = new Map();

async function getAIResponse(callSid, userText) {
  if (!conversations.has(callSid)) conversations.set(callSid, []);
  const history = conversations.get(callSid);
  history.push({ role: 'user', content: userText });
  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'system', content: GYM_PROMPT }, ...history],
        max_tokens: 60,
      },
      { headers: { 'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}` } }
    );
    const reply = res.data.choices[0].message.content.trim();
    history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (err) {
    console.error('Groq error:', err.message);
    return "Welcome to Titan Fitness! How can I help you?";
  }
}

async function getAudioUrl(text) {
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
      { text, model_id: 'eleven_turbo_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      { headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' }
    );
    const filename = `audio_${Date.now()}.mp3`;
    fs.writeFileSync(path.join('/tmp', filename), Buffer.from(res.data));
    return `${CONFIG.BASE_URL}/audio/${filename}`;
  } catch (err) {
    console.error('ElevenLabs error:', err.message);
    return null;
  }
}

app.get('/audio/:f', (req, res) => {
  const fp = path.join('/tmp', req.params.f);
  if (fs.existsSync(fp)) {
    res.set('Content-Type', 'audio/mpeg');
    res.sendFile(fp);
  } else res.status(404).send('Not found');
});

// Use Say as fallback if ElevenLabs fails
function buildXml(audioUrl, text, nextAction, isEnd = false) {
  const audioTag = audioUrl
    ? `<Play>${audioUrl}</Play>`
    : `<Say voice="alice" language="en-IN">${text}</Say>`;

  if (isEnd) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${audioTag}<Hangup/></Response>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${audioTag}
  <Gather input="speech" action="${nextAction}" method="POST" speechTimeout="3" timeout="5" language="en-IN">
  </Gather>
  <Redirect method="POST">${CONFIG.BASE_URL}/no-input</Redirect>
</Response>`;
}

app.all('/incoming-call', async (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || Date.now().toString();
  console.log('📞 Incoming call:', callSid);
  const greeting = await getAIResponse(callSid, 'Customer just called. Greet them warmly in under 15 words.');
  console.log('🤖 Greeting:', greeting);
  const audioUrl = await getAudioUrl(greeting);
  const xml = buildXml(audioUrl, greeting, `${CONFIG.BASE_URL}/process-speech?CallSid=${callSid}`);
  res.type('text/xml').send(xml);
});

app.all('/process-speech', async (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || Date.now().toString();
  const speech = req.body?.SpeechResult || req.query?.SpeechResult || '';
  console.log('🎤 Speech:', speech, '| SID:', callSid);

  const isEnd = ['bye', 'goodbye', 'thank you bye', 'ok bye'].some(k => speech.toLowerCase().includes(k));
  const reply = await getAIResponse(callSid, speech || 'hello');
  console.log('🤖 Reply:', reply);
  const audioUrl = await getAudioUrl(reply);
  const xml = buildXml(audioUrl, reply, `${CONFIG.BASE_URL}/process-speech?CallSid=${callSid}`, isEnd);
  res.type('text/xml').send(xml);
});

app.all('/no-input', async (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || Date.now().toString();
  const msg = "Sorry, I didn't catch that. Please ask your question.";
  const audioUrl = await getAudioUrl(msg);
  const xml = buildXml(audioUrl, msg, `${CONFIG.BASE_URL}/process-speech?CallSid=${callSid}`);
  res.type('text/xml').send(xml);
});

app.get('/', (req, res) => res.json({ status: '🏋️ Gym AI Receptionist running!' }));
server = require('http').createServer(app);
server.listen(CONFIG.PORT, () => console.log(`🏋️ Live on port ${CONFIG.PORT}`));
