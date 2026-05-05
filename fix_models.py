import re

with open('bot.js', 'r') as f:
    bot = f.read()

# Fix CONFIG.GEMINI
bot = bot.replace(
    'lite:  "gemini-3.1-flash-preview"',
    'lite:  "gemini-2.5-flash-lite-preview-06-17"'
)
bot = bot.replace(
    'flash: "gemini-3.1-flash-preview"',
    'flash: "gemini-2.5-flash"'
)
bot = bot.replace(
    'pro:   "gemini-3.1-pro-preview"',
    'pro:   "gemini-2.5-pro"'
)

# Fix hardcoded model in /api/analyze-image route
bot = bot.replace(
    'models/gemini-3.1-flash-preview:generateContent',
    'models/gemini-2.5-flash:generateContent'
)

with open('bot.js', 'w') as f:
    f.write(bot)

# Verify
with open('bot.js', 'r') as f:
    b = f.read()

print("Fixed models:")
for line in b.split('\n'):
    if 'gemini-' in line and ('lite:' in line or 'flash:' in line or 'pro:' in line or 'models/gemini' in line):
        print(" ", line.strip())
