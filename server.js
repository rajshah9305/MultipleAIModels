const express = require(‘express’);
const cors = require(‘cors’);
const path = require(‘path’);
const fs = require(‘fs’).promises;
require(‘dotenv’).config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, ‘public’)));

// In-memory storage (use database in production)
let conversations = {};
let usageStats = {
claude: { totalTokens: 0, totalCost: 0, requestCount: 0, dailyTokens: 0, lastResetDate: new Date().toDateString() },
openai: { totalTokens: 0, totalCost: 0, requestCount: 0, dailyTokens: 0, lastResetDate: new Date().toDateString() },
gemini: { totalTokens: 0, totalCost: 0, requestCount: 0, dailyTokens: 0, lastResetDate: new Date().toDateString() }
};

// Rate limiting storage
let rateLimits = {
claude: { requests: [], tokens: [] },
openai: { requests: [], tokens: [] },
gemini: { requests: [], tokens: [] }
};

// Token pricing per million tokens
const PRICING = {
claude: { input: 3, output: 15 },
openai: { input: 0.15, output: 0.6 },
gemini: { input: 0.075, output: 0.3 }
};

// API limits
const LIMITS = {
claude: { requestsPerMinute: 5, tokensPerMinute: 20000, tokensPerDay: 300000, monthlyLimit: 10 },
openai: { requestsPerMinute: 60, tokensPerMinute: 90000, tokensPerDay: 1000000, monthlyLimit: 5 },
gemini: { requestsPerMinute: 15, tokensPerMinute: 32000, tokensPerDay: 1000000, monthlyLimit: 0 }
};

// Utility functions
function resetDailyUsageIfNeeded() {
const today = new Date().toDateString();
Object.keys(usageStats).forEach(provider => {
if (usageStats[provider].lastResetDate !== today) {
usageStats[provider].dailyTokens = 0;
usageStats[provider].lastResetDate = today;
}
});
}

function cleanOldRateLimitData() {
const oneMinuteAgo = Date.now() - 60000;
Object.keys(rateLimits).forEach(provider => {
rateLimits[provider].requests = rateLimits[provider].requests.filter(time => time > oneMinuteAgo);
rateLimits[provider].tokens = rateLimits[provider].tokens.filter(entry => entry.time > oneMinuteAgo);
});
}

function checkRateLimit(provider) {
cleanOldRateLimitData();
const limits = LIMITS[provider];
const currentRequests = rateLimits[provider].requests.length;
const currentTokens = rateLimits[provider].tokens.reduce((sum, entry) => sum + entry.count, 0);

return {
requestsOk: currentRequests < limits.requestsPerMinute,
tokensOk: currentTokens < limits.tokensPerMinute,
currentRequests,
currentTokens,
maxRequests: limits.requestsPerMinute,
maxTokens: limits.tokensPerMinute
};
}

function estimateTokens(text) {
// Rough estimation: 1 token ≈ 4 characters for English text
return Math.ceil(text.length / 4);
}

function calculateCost(inputTokens, outputTokens, provider) {
const pricing = PRICING[provider];
const inputCost = (inputTokens / 1000000) * pricing.input;
const outputCost = (outputTokens / 1000000) * pricing.output;
return inputCost + outputCost;
}

// Claude API integration
async function callClaudeAPI(messages) {
const response = await fetch(‘https://api.anthropic.com/v1/messages’, {
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’,
‘x-api-key’: process.env.CLAUDE_API_KEY,
‘anthropic-version’: ‘2023-06-01’
},
body: JSON.stringify({
model: ‘claude-3-sonnet-20240229’,
max_tokens: 4000,
messages: messages,
system: “You are a helpful AI assistant specializing in coding and technical support. Provide clear, practical advice with examples.”
})
});

if (!response.ok) {
const errorData = await response.json();
throw new Error(`Claude API error: ${errorData.error?.message || 'Unknown error'}`);
}

return await response.json();
}

// OpenAI API integration
async function callOpenAIAPI(messages) {
const response = await fetch(‘https://api.openai.com/v1/chat/completions’, {
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’,
‘Authorization’: `Bearer ${process.env.OPENAI_API_KEY}`
},
body: JSON.stringify({
model: ‘gpt-4o-mini’,
messages: [
{ role: ‘system’, content: ‘You are a helpful AI assistant specializing in coding and technical support. Provide clear, practical advice with examples.’ },
…messages
],
max_tokens: 4000,
temperature: 0.7
})
});

if (!response.ok) {
const errorData = await response.json();
throw new Error(`OpenAI API error: ${errorData.error?.message || 'Unknown error'}`);
}

return await response.json();
}

// Gemini API integration
async function callGeminiAPI(messages) {
const contents = messages.map(msg => ({
role: msg.role === ‘assistant’ ? ‘model’ : ‘user’,
parts: [{ text: msg.content }]
}));

const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’
},
body: JSON.stringify({
contents: contents,
generationConfig: {
maxOutputTokens: 4000,
temperature: 0.7
},
systemInstruction: {
parts: [{ text: ‘You are a helpful AI assistant specializing in coding and technical support. Provide clear, practical advice with examples.’ }]
}
})
});

if (!response.ok) {
const errorData = await response.json();
throw new Error(`Gemini API error: ${errorData.error?.message || 'Unknown error'}`);
}

return await response.json();
}

// Main chat endpoint
app.post(’/api/chat’, async (req, res) => {
try {
const { message, conversationId, provider = ‘claude’ } = req.body;

```
// Reset daily usage if needed
resetDailyUsageIfNeeded();

// Check if API key is configured
const apiKeyMap = {
  claude: process.env.CLAUDE_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY
};

if (!apiKeyMap[provider]) {
  return res.status(500).json({ 
    error: `${provider.toUpperCase()} API key not configured.` 
  });
}

// Check rate limits
const rateLimitCheck = checkRateLimit(provider);
if (!rateLimitCheck.requestsOk || !rateLimitCheck.tokensOk) {
  return res.status(429).json({ 
    error: 'Rate limit exceeded. Please wait before making another request.',
    rateLimitInfo: rateLimitCheck
  });
}

// Check daily limits
if (usageStats[provider].dailyTokens >= LIMITS[provider].tokensPerDay) {
  return res.status(429).json({ 
    error: 'Daily token limit exceeded. Please try again tomorrow.',
    dailyUsage: usageStats[provider].dailyTokens,
    dailyLimit: LIMITS[provider].tokensPerDay
  });
}

// Initialize conversation
if (!conversations[conversationId]) {
  conversations[conversationId] = [];
}

conversations[conversationId].push({
  role: 'user',
  content: message
});

const messages = conversations[conversationId];

// Estimate input tokens
const inputTokens = estimateTokens(messages.map(m => m.content).join(' '));

// Update rate limiting
rateLimits[provider].requests.push(Date.now());
rateLimits[provider].tokens.push({ time: Date.now(), count: inputTokens });

let apiResponse, assistantMessage, outputTokens;

// Call appropriate API
switch (provider) {
  case 'claude':
    apiResponse = await callClaudeAPI(messages);
    assistantMessage = apiResponse.content[0].text;
    outputTokens = estimateTokens(assistantMessage);
    break;
    
  case 'openai':
    apiResponse = await callOpenAIAPI(messages);
    assistantMessage = apiResponse.choices[0].message.content;
    outputTokens = apiResponse.usage?.completion_tokens || estimateTokens(assistantMessage);
    break;
    
  case 'gemini':
    apiResponse = await callGeminiAPI(messages);
    assistantMessage = apiResponse.candidates[0].content.parts[0].text;
    outputTokens = estimateTokens(assistantMessage);
    break;
    
  default:
    throw new Error('Invalid provider');
}

// Update usage statistics
const totalTokens = inputTokens + outputTokens;
const cost = calculateCost(inputTokens, outputTokens, provider);

usageStats[provider].totalTokens += totalTokens;
usageStats[provider].dailyTokens += totalTokens;
usageStats[provider].totalCost += cost;
usageStats[provider].requestCount += 1;

// Add assistant response to conversation
conversations[conversationId].push({
  role: 'assistant',
  content: assistantMessage
});

res.json({ 
  response: assistantMessage,
  conversationId: conversationId,
  usage: {
    inputTokens,
    outputTokens,
    totalTokens,
    cost: cost.toFixed(6),
    provider
  }
});
```

} catch (error) {
console.error(`Error calling ${req.body.provider || 'AI'} API:`, error);
res.status(500).json({
error: `Failed to get response from ${req.body.provider || 'AI'}. Please check your API key and try again.`,
details: error.message
});
}
});

// Usage statistics endpoint
app.get(’/api/usage’, (req, res) => {
resetDailyUsageIfNeeded();
cleanOldRateLimitData();

const currentUsage = {};

Object.keys(usageStats).forEach(provider => {
const rateLimitCheck = checkRateLimit(provider);
const limits = LIMITS[provider];

```
currentUsage[provider] = {
  ...usageStats[provider],
  rateLimits: {
    requests: {
      current: rateLimitCheck.currentRequests,
      max: rateLimitCheck.maxRequests,
      remaining: rateLimitCheck.maxRequests - rateLimitCheck.currentRequests
    },
    tokens: {
      current: rateLimitCheck.currentTokens,
      max: rateLimitCheck.maxTokens,
      remaining: rateLimitCheck.maxTokens - rateLimitCheck.currentTokens
    }
  },
  dailyLimits: {
    current: usageStats[provider].dailyTokens,
    max: limits.tokensPerDay,
    remaining: limits.tokensPerDay - usageStats[provider].dailyTokens
  },
  monthlyLimits: {
    current: usageStats[provider].totalCost,
    max: limits.monthlyLimit,
    remaining: Math.max(0, limits.monthlyLimit - usageStats[provider].totalCost)
  },
  pricing: PRICING[provider]
};
```

});

res.json(currentUsage);
});

// Token calculator endpoint
app.post(’/api/calculate-tokens’, (req, res) => {
const { text, provider = ‘claude’ } = req.body;
const tokens = estimateTokens(text);
const inputCost = calculateCost(tokens, 0, provider);
const outputCost = calculateCost(0, tokens, provider);

res.json({
tokens,
estimatedInputCost: inputCost.toFixed(6),
estimatedOutputCost: outputCost.toFixed(6),
provider,
pricing: PRICING[provider]
});
});

// Health check endpoint
app.get(’/api/health’, (req, res) => {
const configuredAPIs = {
claude: !!process.env.CLAUDE_API_KEY,
openai: !!process.env.OPENAI_API_KEY,
gemini: !!process.env.GEMINI_API_KEY
};

res.json({
status: ‘Server is running!’,
configuredAPIs,
totalConfigured: Object.values(configuredAPIs).filter(Boolean).length
});
});

// Reset usage endpoint (for testing)
app.post(’/api/reset-usage’, (req, res) => {
const { provider } = req.body;
if (provider && usageStats[provider]) {
usageStats[provider] = {
totalTokens: 0,
totalCost: 0,
requestCount: 0,
dailyTokens: 0,
lastResetDate: new Date().toDateString()
};
rateLimits[provider] = { requests: [], tokens: [] };
}
res.json({ message: `Usage reset for ${provider}` });
});

// Serve the frontend
app.get(’*’, (req, res) => {
res.sendFile(path.join(__dirname, ‘public’, ‘index.html’));
});

app.listen(PORT, () => {
console.log(`🚀 Server running on http://localhost:${PORT}`);
console.log(`💡 Configured APIs: ${Object.entries({ Claude: !!process.env.CLAUDE_API_KEY, OpenAI: !!process.env.OPENAI_API_KEY, Gemini: !!process.env.GEMINI_API_KEY }).filter(([name, configured]) => configured).map(([name]) => name).join(', ') || 'None'}`);
});
