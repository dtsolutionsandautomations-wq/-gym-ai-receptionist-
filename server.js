const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  BASE_URL: process.env.BASE_URL || 'https://gym-ai-receptionist.onrender.com',
  PORT: process.env.PORT || 3000,
};

console.log('GROQ:', CONFIG.GROQ_API_KEY ? 'SET' : 'MISSING');
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

function xml(say, nextUrl, isEnd = false) {
  if (isEnd) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-IN">${say}</Say>
  <Hangup/>
</Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-IN">${say}</Say>
  <Gather input="speech" action="${nextUrl}" method="POST" speechTimeout="3" timeout="6" language="en-IN"></Gather>
  <Redirect method="POST">${CONFIG.BASE_URL}/no-input</Redirect>
</Response>`;
}

app.all('/incoming-call', async (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || Date.now().toString();
  console.log('📞 Call:', callSid);
  const greeting = await getAIResponse(callSid, 'Customer called. Greet warmly under 15 words.');
  console.log('🤖 Greeting:', greeting);
  res.type('text/xml').send(xml(greeting, `${CONFIG.BASE_URL}/process-speech?CallSid=${callSid}`));
});

app.all('/process-speech', async (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || Date.now().toString();
  const speech = req.body?.SpeechResult || req.query?.SpeechResult || '';
  console.log('🎤 Speech:', speech);
  const isEnd = ['bye', 'goodbye', 'ok bye'].some(k => speech.toLowerCase().includes(k));
  const reply = await getAIResponse(callSid, speech || 'hello');
  console.log('🤖 Reply:', reply);
  res.type('text/xml').send(xml(reply, `${CONFIG.BASE_URL}/process-speech?CallSid=${callSid}`, isEnd));
});

app.all('/no-input', (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || '';
  res.type('text/xml').send(xml(
    "Sorry, I didn't catch that. How can I help you?",
    `${CONFIG.BASE_URL}/process-speech?CallSid=${callSid}`
  ));
});

app.get('/', (req, res) => res.json({ status: '🏋️ Running!' }));
app.listen(CONFIG.PORT, () => console.log(`🏋️ Live on port ${CONFIG.PORT}`));
