// ============================================================
//  GYM AI RECEPTIONIST — server.js
//  Stack: Exotel (+91 numbers) + Gemini AI (FREE) + ElevenLabs (voice)
// ============================================================

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
  EXOTEL_SID: process.env.EXOTEL_SID,
  BASE_URL: process.env.BASE_URL || 'https://gym-ai-receptionist.onrender.com',
  PORT: process.env.PORT || 3000,
};


console.log('CONFIG CHECK:');
console.log('  BASE_URL:', CONFIG.BASE_URL);
console.log('  GROQ_API_KEY:', CONFIG.GROQ_API_KEY ? 'SET' : 'MISSING');
console.log('  ELEVENLABS_API_KEY:', CONFIG.ELEVENLABS_API_KEY ? 'SET' : 'MISSING');

// ── TWIML BUILDER (Exotel uses same XML format as Twilio) ────
function VoiceResponse() {
  this.actions = [];
  this.play = (url) => { this.actions.push(`<Play>${url}</Play>`); };
  this.say = (opts, text) => {
    this.actions.push(`<Say voice="woman" language="en-IN">${text}</Say>`);
  };
  this.gather = (opts) => {
    const g = { _inner: [], say: function(t) { if(t) this._inner.push(`<Say>${t}</Say>`); return this; } };
    const attr = `input="speech" action="${opts.action}" speechTimeout="auto" language="en-IN"`;
    this.actions.push({ isGather: true, attr, ref: g });
    return g;
  };
  this.redirect = (url) => { this.actions.push(`<Redirect>${url}</Redirect>`); };
  this.hangup = () => { this.actions.push('<Hangup/>'); };
  this.toString = () => {
    const inner = this.actions.map(a => {
      if (a && a.isGather) return `<Gather ${a.attr}>${a.ref._inner.join('')}</Gather>`;
      return a;
    }).join('\n  ');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${inner}\n</Response>`;
  };
}

// ── GYM PROFILES ─────────────────────────────────────────────
const GYM_PROFILES = {
  default: {
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
- Manager: +91-98765-43210 for special requests

RULES:
- For trial booking ask their name and preferred date
- If unsure, say "Let me have our manager call you back within 2 hours"
- End calls with: "Thank you for calling Titan Fitness! Have a great day!"`,
  },
};

function getGymProfile() {
  return GYM_PROFILES.default;
}

// ── CONVERSATION MEMORY ──────────────────────────────────────
const conversations = new Map();
function getHistory(callSid) {
  if (!conversations.has(callSid)) conversations.set(callSid, []);
  return conversations.get(callSid);
}
function clearHistory(callSid) { conversations.delete(callSid); }

// Auto-clear old conversations after 30 mins
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [sid, msgs] of conversations.entries()) {
    if (msgs._ts && msgs._ts < cutoff) conversations.delete(sid);
  }
}, 5 * 60 * 1000);

// ── GROQ AI RESPONSE (FREE, NO QUOTA ISSUES) ────────────────
async function getAIResponse(userMessage, callSid, gymProfile) {
  const history = getHistory(callSid);
  history.push({ role: 'user', content: userMessage });
  history._ts = Date.now();

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: gymProfile.systemPrompt },
          ...history.filter(m => m.role)
        ],
        max_tokens: 150,
        temperature: 0.7,
      },
      {
        headers: {
          'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const aiText = response.data.choices[0].message.content;
    history.push({ role: 'assistant', content: aiText });
    return aiText;
  } catch (err) {
    console.error('Groq error:', err.response?.data || err.message);
    return "I'm sorry, I'm having a small issue right now. Please hold on or I'll have our manager call you back.";
  }
}

// ── ELEVENLABS: TEXT TO SPEECH ───────────────────────────────
async function textToSpeech(text) {
  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
      },
      {
        headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
      }
    );
    const filename = `speech_${Date.now()}.mp3`;
    const filepath = path.join('/tmp', filename);
    fs.writeFileSync(filepath, response.data);
    return { filename, filepath };
  } catch (err) {
    console.error('ElevenLabs error:', err.message);
    return null;
  }
}

// ── SERVE AUDIO FILES ────────────────────────────────────────
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

// ── WEBHOOK: INCOMING CALL ───────────────────────────────────
app.all('/incoming-call', async (req, res) => {
  const callSid = req.body.CallSid || Date.now().toString();
  const gymProfile = getGymProfile();
  console.log(`📞 Incoming call | SID: ${callSid}`);

  const greeting = await getAIResponse(
    'A customer just called the gym. Give a warm short greeting and ask how you can help.',
    callSid, gymProfile
  );
  console.log(`🤖 Greeting: "${greeting}"`);

  const audio = await textToSpeech(greeting);
  const twiml = new VoiceResponse();

  if (audio) {
    twiml.play(`${CONFIG.BASE_URL}/audio/${audio.filename}`);
  } else {
    twiml.say({}, greeting);
  }

  const gather = twiml.gather({ action: `${CONFIG.BASE_URL}/process-speech` });
  gather.say('');
  twiml.redirect(`${CONFIG.BASE_URL}/no-input`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── WEBHOOK: PROCESS SPEECH ──────────────────────────────────
app.all('/process-speech', async (req, res) => {
  const callSid = req.body.CallSid || Date.now().toString();
  const speechResult = req.body.SpeechResult || '';
  const gymProfile = getGymProfile();
  console.log(`🎤 Customer: "${speechResult}"`);

  const twiml = new VoiceResponse();

  if (!speechResult.trim()) {
    twiml.redirect(`${CONFIG.BASE_URL}/no-input`);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const endKeywords = ['bye', 'goodbye', 'thank you bye', 'ok bye', "that's all", 'nothing else'];
  const isEnding = endKeywords.some(kw => speechResult.toLowerCase().includes(kw));

  const aiResponse = await getAIResponse(speechResult, callSid, gymProfile);
  console.log(`🤖 AI: "${aiResponse}"`);

  const audio = await textToSpeech(aiResponse);

  if (audio) {
    twiml.play(`${CONFIG.BASE_URL}/audio/${audio.filename}`);
  } else {
    twiml.say({}, aiResponse);
  }

  if (isEnding) {
    clearHistory(callSid);
    twiml.hangup();
  } else {
    twiml.gather({ action: `${CONFIG.BASE_URL}/process-speech` });
    twiml.redirect(`${CONFIG.BASE_URL}/no-input`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── WEBHOOK: NO INPUT ────────────────────────────────────────
app.all('/no-input', async (req, res) => {
  const twiml = new VoiceResponse();
  const audio = await textToSpeech("Sorry, I didn't catch that. Could you please repeat?");
  if (audio) {
    twiml.play(`${CONFIG.BASE_URL}/audio/${audio.filename}`);
  } else {
    twiml.say({}, "Sorry, I didn't catch that. Could you please repeat?");
  }
  twiml.gather({ action: `${CONFIG.BASE_URL}/process-speech` });
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: '🏋️ Gym AI Receptionist running!', gym: GYM_PROFILES.default.name });
});

app.listen(CONFIG.PORT, () => {
  console.log(`🏋️  Gym AI Receptionist live on port ${CONFIG.PORT}`);
});
