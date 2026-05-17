// ============================================================
//  GYM AI RECEPTIONIST — server.js
//  Stack: Exotel (Indian +91 numbers) + Claude (AI) + ElevenLabs (voice)
//  Deploy to Railway.app or Render.com (free tier works for demo)
//
//  WHY EXOTEL instead of Twilio:
//  Twilio does NOT sell Indian (+91) numbers due to TRAI regulations.
//  Exotel is India's leading cloud telephony provider with real +91 DID
//  numbers, TRAI compliance, and a Twilio-compatible API format.
//  Sign up free at: https://exotel.com (15-day trial + ₹1000 free usage)
// ============================================================

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL', // "Aria" - natural female voice

  // ── EXOTEL (replaces Twilio for Indian numbers) ──────────
  // Find these in Exotel Dashboard → Settings → API
  EXOTEL_SID: process.env.EXOTEL_SID,          // your Account SID
  EXOTEL_KEY: process.env.EXOTEL_KEY,          // API Key
  EXOTEL_TOKEN: process.env.EXOTEL_TOKEN,      // API Token
  EXOTEL_SUBDOMAIN: process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com', // check your dashboard

  PORT: process.env.PORT || 3000,
  BASE_URL: process.env.BASE_URL, // e.g. https://your-app.railway.app
};

// Exotel uses same TwiML XML format as Twilio — we build it manually
// (no need for twilio npm package)
function VoiceResponse() {
  this.actions = [];
  this.play = (url) => { this.actions.push(`<Play>${url}</Play>`); return this; };
  this.say = (opts, text) => {
    const voice = opts.voice || 'woman';
    this.actions.push(`<Say voice="${voice}" language="en-IN">${text}</Say>`);
    return this;
  };
  this.gather = (opts) => {
    const g = {
      _inner: [],
      say: function(t) { if (t) this._inner.push(`<Say>${t}</Say>`); return this; },
    };
    const attribs = Object.entries({
      input: opts.input || 'speech',
      action: opts.action,
      speechTimeout: opts.speechTimeout || 'auto',
      language: opts.language || 'en-IN',
    }).map(([k,v]) => `${k}="${v}"`).join(' ');
    this._gatherStr = () => `<Gather ${attribs}>${g._inner.join('')}</Gather>`;
    this.actions.push({ isGather: true, ref: g });
    return g;
  };
  this.redirect = (url) => { this.actions.push(`<Redirect>${url}</Redirect>`); return this; };
  this.hangup = () => { this.actions.push('<Hangup/>'); return this; };
  this.toString = () => {
    const inner = this.actions.map(a => {
      if (a && a.isGather) return a.ref._gatherStr();
      return a;
    }).join('\n  ');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${inner}\n</Response>`;
  };
}

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// ── GYM PROFILES ────────────────────────────────────────────
// Add as many gyms as you sell to. Each gets their own system prompt.
const GYM_PROFILES = {
  default: {
    name: 'Titan Fitness Gym',
    phone: '+918012345678', // Twilio number for this gym
    systemPrompt: `You are Priya, the friendly AI receptionist at Titan Fitness Gym in Bengaluru.
You speak naturally, warmly, and professionally — like a real human receptionist.
Keep answers concise (2-4 sentences max) since this is a phone call.
Always speak in English but you can mix a little Hindi if the caller does (e.g. "bilkul", "theek hai").

GYM INFORMATION:
- Name: Titan Fitness Gym, Koramangala 5th Block, Bengaluru
- Timings: Mon–Sat 5:30 AM–10:30 PM, Sunday 6 AM–8 PM
- Membership: Basic ₹1,999/mo | Premium ₹2,999/mo (includes group classes) | Quarterly ₹5,999 | Annual ₹19,999
- Personal Trainers: 6 certified PTs, sessions from ₹499
- Free trial: Yes, 1-day free pass available
- Facilities: AC gym, cardio zone, free weights, group studio, steam room, protein bar
- Manager contact: +91-98765-43210 (for complaints or special requests)

RULES:
- If asked to book a trial or appointment, ask for their name and preferred date/time, then confirm it
- If you cannot answer something, say "Let me have our manager call you back within 2 hours"
- Never make up prices or information not listed above
- End calls warmly: "Thank you for calling Titan Fitness! Have a great day!"`,
  },

  // ── SECOND GYM EXAMPLE (duplicate this block per client) ──
  powerzone: {
    name: 'PowerZone Gym',
    phone: '+918098765432', // different Twilio number
    systemPrompt: `You are Anjali, the friendly AI receptionist at PowerZone Gym in Indiranagar, Bengaluru.
Keep answers concise since this is a phone call.

GYM INFORMATION:
- Name: PowerZone Gym, 100 Feet Road, Indiranagar, Bengaluru
- Timings: Open 24/7 (staff available 6 AM–10 PM)
- Membership: Classic ₹1,799/mo | Elite ₹3,499/mo | 6 months ₹9,999 | Student 20% off with ID
- Personal Trainers: 8 coaches including 2 international-level athletes
- Free trial: Yes, free trial any weekday
- Facilities: Olympic platform, CrossFit rig, cycling studio, smoothie bar, women's zone

RULES:
- If you cannot answer, say "Let me have our team call you back shortly"
- End calls with: "Thanks for calling PowerZone — stay strong!"`,
  },
};

// ── CONVERSATION MEMORY ─────────────────────────────────────
// Stores conversation per call SID (Twilio's unique call ID)
const conversations = new Map();

function getConversation(callSid) {
  if (!conversations.has(callSid)) {
    conversations.set(callSid, []);
  }
  return conversations.get(callSid);
}

function clearConversation(callSid) {
  conversations.delete(callSid);
}

// Auto-clear old conversations after 30 mins (memory management)
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [sid, msgs] of conversations.entries()) {
    if (msgs._timestamp && msgs._timestamp < cutoff) {
      conversations.delete(sid);
    }
  }
}, 5 * 60 * 1000);

// ── GET GYM PROFILE FROM TWILIO NUMBER ──────────────────────
function getGymProfile(toNumber) {
  for (const [key, gym] of Object.entries(GYM_PROFILES)) {
    if (gym.phone === toNumber) return gym;
  }
  return GYM_PROFILES.default;
}

// ── ELEVENLABS: TEXT → SPEECH ────────────────────────────────
async function textToSpeech(text) {
  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: 'eleven_turbo_v2', // fastest, lowest latency
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          'xi-api-key': CONFIG.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      }
    );

    // Save audio temporarily
    const filename = `speech_${Date.now()}.mp3`;
    const filepath = path.join('/tmp', filename);
    fs.writeFileSync(filepath, response.data);

    return { filename, filepath };
  } catch (err) {
    console.error('ElevenLabs error:', err.message);
    return null;
  }
}

// ── CLAUDE: GET AI RESPONSE ──────────────────────────────────
async function getAIResponse(userMessage, callSid, gymProfile) {
  const history = getConversation(callSid);
  history.push({ role: 'user', content: userMessage });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200, // Short for phone calls
      system: gymProfile.systemPrompt,
      messages: history,
    });

    const aiText = response.content[0].text;
    history.push({ role: 'assistant', content: aiText });
    history._timestamp = Date.now();

    return aiText;
  } catch (err) {
    console.error('Claude API error:', err.message);
    return "I'm sorry, I'm having a small technical issue. Please call back in a moment, or I can have our manager call you.";
  }
}

// ── SERVE AUDIO FILES ────────────────────────────────────────
app.get('/audio/:filename', (req, res) => {
  const filepath = path.join('/tmp', req.params.filename);
  if (fs.existsSync(filepath)) {
    res.set('Content-Type', 'audio/mpeg');
    res.sendFile(filepath);
    // Clean up after 60 seconds
    setTimeout(() => fs.existsSync(filepath) && fs.unlinkSync(filepath), 60000);
  } else {
    res.status(404).send('Not found');
  }
});

// ── TWILIO WEBHOOK: INCOMING CALL ────────────────────────────
app.post('/incoming-call', async (req, res) => {
  const callSid = req.body.CallSid;
  const toNumber = req.body.To;
  const gymProfile = getGymProfile(toNumber);

  console.log(`📞 Incoming call → ${gymProfile.name} | SID: ${callSid}`);

  // Generate greeting
  const greeting = await getAIResponse(
    'A customer just called. Give them a warm greeting and ask how you can help.',
    callSid,
    gymProfile
  );

  const audio = await textToSpeech(greeting);

  const twiml = new VoiceResponse();

  if (audio) {
    twiml.play(`${CONFIG.BASE_URL}/audio/${audio.filename}`);
  } else {
    twiml.say({ voice: 'woman' }, greeting); // Fallback: Exotel built-in TTS
  }

  // Gather speech input from caller
  const gather = twiml.gather({
    input: 'speech',
    action: `${CONFIG.BASE_URL}/process-speech`,
    speechTimeout: 'auto',
    language: 'en-IN',
  });
  gather.say('');

  // If no input after timeout
  twiml.redirect(`${CONFIG.BASE_URL}/no-input`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── TWILIO WEBHOOK: PROCESS SPEECH ──────────────────────────
app.post('/process-speech', async (req, res) => {
  const callSid = req.body.CallSid;
  const toNumber = req.body.To;
  const speechResult = req.body.SpeechResult || '';
  const gymProfile = getGymProfile(toNumber);

  console.log(`🎤 [${gymProfile.name}] Customer said: "${speechResult}"`);

  const twiml = new VoiceResponse();

  if (!speechResult.trim()) {
    twiml.redirect(`${CONFIG.BASE_URL}/no-input`);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Check if caller wants to end call
  const endKeywords = ['bye', 'goodbye', 'thank you bye', 'ok bye', 'that\'s all', 'nothing else'];
  const isEnding = endKeywords.some(kw => speechResult.toLowerCase().includes(kw));

  const aiResponse = await getAIResponse(speechResult, callSid, gymProfile);
  console.log(`🤖 AI replied: "${aiResponse}"`);

  const audio = await textToSpeech(aiResponse);

  if (audio) {
    twiml.play(`${CONFIG.BASE_URL}/audio/${audio.filename}`);
  } else {
    twiml.say({ voice: 'woman' }, aiResponse);
  }

  if (isEnding) {
    clearConversation(callSid);
    twiml.hangup();
  } else {
    twiml.gather({
      input: 'speech',
      action: `${CONFIG.BASE_URL}/process-speech`,
      speechTimeout: 'auto',
      language: 'en-IN',
    });
    twiml.redirect(`${CONFIG.BASE_URL}/no-input`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── TWILIO WEBHOOK: NO INPUT HANDLER ────────────────────────
app.post('/no-input', async (req, res) => {
  const callSid = req.body.CallSid;
  const toNumber = req.body.To;
  const gymProfile = getGymProfile(toNumber);

  const twiml = new VoiceResponse();
  const audio = await textToSpeech("I didn't catch that. Could you please repeat your question?");

  if (audio) {
    twiml.play(`${CONFIG.BASE_URL}/audio/${audio.filename}`);
  } else {
    twiml.say({ voice: 'woman' }, "I didn't catch that. Could you please repeat your question?");
  }

  twiml.gather({
    input: 'speech',
    action: `${CONFIG.BASE_URL}/process-speech`,
    speechTimeout: 'auto',
    language: 'en-IN',
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    gyms: Object.values(GYM_PROFILES).map(g => ({ name: g.name, phone: g.phone })),
    uptime: process.uptime(),
  });
});

// ── START SERVER ─────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🏋️  GYM AI RECEPTIONIST SERVER          ║
║   Running on port ${CONFIG.PORT}                  ║  
║   Gyms loaded: ${Object.keys(GYM_PROFILES).length}                        ║
╚══════════════════════════════════════════╝
  `);
});
